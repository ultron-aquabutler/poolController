/*  nodejs-poolController.  An application to control pool equipment.
Copyright (C) 2016, 2017, 2018, 2019, 2020, 2021, 2022.
Russell Goldin, tagyoureit.  russ.goldin@gmail.com

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

/**
 * Simulator harness integration tests.
 *
 * Uses node:test (built-in) so there are no extra devDeps to add.
 * Runs against the in-process PanelSimulator — no real RS-485 hardware
 * needed. Designed to run on x86 linux CI and aarch64 RPi identically.
 *
 * Six subtests:
 *   1. boots in simulate mode (HTTP server is listening)
 *   2. PanelSimulator acks SET circuit commands
 *   3. waitForState() resolves when predicate becomes truthy
 *   4. multiple SET commands mutate panel state correctly
 *   5. simulator tracks every decoded command in arrival order
 *   6. PanelSimulator returns a date/time reply for GET 197
 *
 * A single shared simulator is used across all subtests — the harness
 * stops individual resources between tests via `stop()` and the
 * process is torn down once at the end via `fullTeardown()`.
 *
 * The final `test.after` hook invokes `fullTeardown()` so the runner
 * exits cleanly. Without it, njsPC's AquaLinkBoard keeps a setInterval
 * alive (heliotrope recalculation every ~18s) and `npm test` hangs
 * even after all subtests pass.
 */

import * as nodeTest from 'node:test';
import * as nodeAssert from 'node:assert/strict';

import {
    SimulatorHarness,
    SimulatorHandle,
    fullTeardown,
    installExitHook,
} from '../../controller/simulator/SimulatorHarness';
import { PanelSimulator } from '../../controller/simulator/PanelSimulator';
import { SimulatedSerialPort } from '../../controller/simulator/SimulatedSerialPort';
import { defaultPanelState } from '../../controller/simulator/PanelState';

const test: typeof nodeTest.test = nodeTest.test as any;
const assert: typeof nodeAssert = nodeAssert as any;

// One shared harness for the whole file. Each subtest does its own start/stop
// against the default registry key so the simulator is fresh per subtest.
installExitHook();

let sim: SimulatorHandle;

test('simulator harness: boots poolController in simulate mode', async (t) => {
    sim = await SimulatorHarness.start('boots');
    t.after(async () => { try { await sim.stop(); } catch { /* ignore */ } });

    // HTTP must be listening on the picked port.
    assert.ok(sim.httpPort > 0, 'httpPort should be a positive integer');
    assert.ok(sim.socket.connected, 'socket.io client should be connected');

    // The patched serialport shim should have created a SimulatedSerialPort.
    assert.ok(
        sim.simulatedPorts.length > 0,
        'expected at least one SimulatedSerialPort to be created'
    );
    for (const port of sim.simulatedPorts) {
        assert.ok(port instanceof SimulatedSerialPort, 'port is a SimulatedSerialPort');
        assert.equal(port.isOpen, true, 'sim port is open');
    }

    // The simulator should be the PanelSimulator we created.
    assert.ok(sim.simulator instanceof PanelSimulator);
});

test('simulator harness: PanelSimulator acks SET circuit (134) commands', async (t) => {
    sim = await SimulatorHarness.start('ack-set');
    t.after(async () => { try { await sim.stop(); } catch { /* ignore */ } });

    // Build a SET 134 frame for circuit 1, isOn=1, from controller (15) to panel (16).
    // Layout: [0xFF, 0x00, 0xFF, 0xA5, sub=0, dest=16, src=15, action=134, datalen=2,
    //          circuitId=1, isOn=1, chkHi, chkLo]
    const frame: number[] = [0xff, 0x00, 0xff, 0xa5, 0x00, 0x10, 0x0f, 134, 2, 1, 1];
    let sum = 0;
    for (let i = 3; i < frame.length; i++) sum += frame[i];
    frame.push(Math.floor(sum / 256) & 0xff, sum & 0xff);
    const buf = Buffer.from(frame);

    const port = sim.simulatedPorts[0];
    assert.ok(port, 'sim port exists');

    const responses = sim.simulator.feed(port.path, buf);
    assert.equal(responses.length, 1, 'simulator returns one ack packet');
    const r = responses[0];
    // Ack is action=1 in the response. Index 7 of the frame is action.
    assert.equal(r[7], 1, 'response action is 1 (Ack)');
    assert.equal(r[8], 1, 'ack payload has length 1');
    assert.equal(r[9], 134, 'ack payload references the original action');
    // The circuit should now be on.
    assert.equal(sim.simulator.getCircuit(1)?.isOn, true);
});

test('simulator harness: waitForState resolves when predicate is truthy', async (t) => {
    sim = await SimulatorHarness.start('wait-state');
    t.after(async () => { try { await sim.stop(); } catch { /* ignore */ } });

    // The harness always resolves waitForState immediately if the predicate is
    // truthy on first check.
    await sim.waitForState((_s) => true, 1000);

    // A false predicate should time out.
    await assert.rejects(
        () => sim.waitForState(() => false, 100),
        /timed out/
    );
});

test('simulator harness: multiple SET commands mutate panel state', async (t) => {
    sim = await SimulatorHarness.start('multi-set');
    t.after(async () => { try { await sim.stop(); } catch { /* ignore */ } });

    const initial = defaultPanelState();
    assert.deepEqual(
        sim.simulator.state.circuits.map(c => ({ id: c.id, isOn: c.isOn })),
        initial.circuits.map(c => ({ id: c.id, isOn: c.isOn })),
        'simulator starts in default state'
    );

    // Flip circuits 3 and 5 on.
    const flipFrame = (circuitId: number, isOn: 0 | 1) => {
        const frame: number[] = [0xff, 0x00, 0xff, 0xa5, 0x00, 0x10, 0x0f, 134, 2, circuitId, isOn];
        let sum = 0;
        for (let i = 3; i < frame.length; i++) sum += frame[i];
        frame.push(Math.floor(sum / 256) & 0xff, sum & 0xff);
        return Buffer.from(frame);
    };
    sim.simulator.feed('MOCK_PORT', flipFrame(3, 1));
    sim.simulator.feed('MOCK_PORT', flipFrame(5, 1));
    sim.simulator.feed('MOCK_PORT', flipFrame(3, 0));

    assert.equal(sim.simulator.getCircuit(3)?.isOn, false, 'circuit 3 ended off');
    assert.equal(sim.simulator.getCircuit(5)?.isOn, true, 'circuit 5 ended on');
});

test('simulator harness: simulator tracks every decoded command', async (t) => {
    sim = await SimulatorHarness.start('track-cmds');
    t.after(async () => { try { await sim.stop(); } catch { /* ignore */ } });

    // Issue two distinct SET commands.
    const setCircuit = (id: number, on: 0 | 1) => {
        const frame: number[] = [0xff, 0x00, 0xff, 0xa5, 0x00, 0x10, 0x0f, 134, 2, id, on];
        let sum = 0;
        for (let i = 3; i < frame.length; i++) sum += frame[i];
        frame.push(Math.floor(sum / 256) & 0xff, sum & 0xff);
        return Buffer.from(frame);
    };
    const setHeat = () => {
        // SET 136: heat mode=1 (heater), body=85, spa=100, raw payload [1,85,100]
        const payload = [1, 85, 100];
        const frame: number[] = [0xff, 0x00, 0xff, 0xa5, 0x00, 0x10, 0x0f, 136, payload.length, ...payload];
        let sum = 0;
        for (let i = 3; i < frame.length; i++) sum += frame[i];
        frame.push(Math.floor(sum / 256) & 0xff, sum & 0xff);
        return Buffer.from(frame);
    };
    sim.simulator.feed('MOCK_PORT', setCircuit(2, 1));
    sim.simulator.feed('MOCK_PORT', setHeat());
    sim.simulator.feed('MOCK_PORT', setCircuit(4, 1));

    const cmds = sim.simulator.commands;
    assert.equal(cmds.length, 3, 'three commands decoded');
    assert.equal(cmds[0].action, 134, 'first was SET circuit');
    assert.equal(cmds[1].action, 136, 'second was SET heat');
    assert.equal(cmds[2].action, 134, 'third was SET circuit');
    assert.equal(cmds[0].payload[0], 2);
    assert.equal(cmds[1].payload[1], 85);
    assert.equal(cmds[2].payload[0], 4);
});

test('simulator harness: PanelSimulator returns date/time on GET 197', async (t) => {
    sim = await SimulatorHarness.start('get-datetime');
    t.after(async () => { try { await sim.stop(); } catch { /* ignore */ } });

    // GET 197 frame: [preamble, 0xA5, sub=0, dest=panel=16, src=ctrl=15, action=197,
    //                 datalen=0, chkHi, chkLo]
    const frame: number[] = [0xff, 0x00, 0xff, 0xa5, 0x00, 0x10, 0x0f, 197, 0];
    let sum = 0;
    for (let i = 3; i < frame.length; i++) sum += frame[i];
    frame.push(Math.floor(sum / 256) & 0xff, sum & 0xff);
    const buf = Buffer.from(frame);

    const responses = sim.simulator.feed('MOCK_PORT', buf);
    assert.equal(responses.length, 1, 'one response');
    const r = responses[0];
    // Index 7 = action. Index 8 = datalen. Index 9..15 = payload.
    assert.equal(r[7], 5, 'response action is 5 (date/time)');
    assert.equal(r[8], 7, 'date/time payload is 7 bytes');
});

// Suite-level teardown: stop njsPC app + close simulator so `npm test` exits 0.
// fullTeardown() internally calls app.stopAsync() which ends with process.exit().
test.after(async () => {
    await fullTeardown();
});
