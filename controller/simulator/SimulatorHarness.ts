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
 * SimulatorHarness — boots poolController with simulated RS-485 ports
 * and exposes a clean API for integration tests.
 *
 *  Usage from a test:
 *
 *      const sim = await SimulatorHarness.start();
 *      await sim.waitForState(s => s.circuits.getItemById(1).isOn === true);
 *      await sim.stop();
 *
 * The harness:
 *   - replaces the `serialport` package's MockBinding factory with a
 *     SimulatedSerialPort-backed implementation that delegates writes
 *     to a PanelSimulator instance;
 *   - waits for the HTTP server to be listening and the socket.io
 *     server to be accepting connections;
 *   - returns a connected socket.io client + REST URL + helpers.
 */

import * as net from 'net';
import type { Socket } from 'socket.io-client';
import { io as sockClient } from 'socket.io-client';
import { PanelSimulator, PanelSimulatorOptions } from './PanelSimulator';
import { SimulatedSerialPort } from './SimulatedSerialPort';
import { state } from '../State';
import { sys } from '../Equipment';
import { config } from '../../config/Config';

export interface SimulatorOptions extends PanelSimulatorOptions {
    /** Override the HTTP port poolController binds to. Default = pick a free port. */
    httpPort?: number;
    /** Don't actually start the socket.io server. Default false. */
    headless?: boolean;
}

export interface SimulatorHandle {
    /** Connected socket.io client subscribed to the controller's state stream. */
    socket: Socket;
    /** HTTP REST port — http://localhost:<port> */
    httpPort: number;
    /** The simulated panel for assertions. */
    simulator: PanelSimulator;
    /** All SimulatedSerialPort instances created during this run. */
    simulatedPorts: SimulatedSerialPort[];
    /** Resolves when `predicate(state)` returns truthy, or rejects on timeout. */
    waitForState: (
        predicate: (s: typeof state) => boolean | Promise<boolean>,
        timeoutMs?: number
    ) => Promise<void>;
    /** Stop poolController, close sockets, release timers. */
    stop: () => Promise<void>;
}

/**
 * Module handle for the inner `serialport-mock.js` module whose
 * `exports.SerialPortMock` is the writable binding the outer
 * `serialport` package re-exports via a getter.
 *
 * We keep both the original `SerialPortMock` class and the original
 * `binding` object so they can be restored on teardown.
 */
interface OriginalSerialPortShim {
    innerModule: any;
    realMock: any;
    realBinding: any;
}
let originalShim: OriginalSerialPortShim | null = null;

interface SimRegistry {
    simulator: PanelSimulator;
    ports: SimulatedSerialPort[];
}

/** Process-wide registry of currently-running simulators, keyed by test name. */
const registries = new Map<string, SimRegistry>();

/**
 * Patch the serialport package so any `new SerialPortMock({ path: 'MOCK_PORT' })`
 * call returns a SimulatedSerialPort bound to the active simulator instead.
 *
 * The exported `serialport.SerialPortMock` is a read-only getter (ESM-style
 * __createBinding on the outer `serialport/dist/index.js`) — assigning to it
 * throws "Cannot set property SerialPortMock of #<Object> which has only a
 * getter" in Node 20+. We instead rewrite the **inner** `serialport-mock.js`
 * module's `exports.SerialPortMock`, which is a plain writable property and
 * is what the getter resolves to on every fresh access. PoolController
 * accesses `SerialPortMock` through the getter (CJS compiled form
 * `serialport_1.SerialPortMock`) at the call site, so it picks up our
 * replacement automatically without needing to re-require the module.
 */
function installSerialPortShim(simulator: PanelSimulator): {
    restore: () => void;
    ports: SimulatedSerialPort[];
} {
    const ports: SimulatedSerialPort[] = [];
    // The inner module is what `serialport/dist/index.js` re-exports. Its
    // `exports.SerialPortMock` is the underlying source the outer getter
    // reads on every access.
    const innerMockModule: any = require('serialport/dist/serialport-mock');
    const RealMock = innerMockModule.SerialPortMock;
    const RealBinding = RealMock.binding;

    if (!originalShim) {
        originalShim = {
            innerModule: innerMockModule,
            realMock: RealMock,
            realBinding: RealBinding,
        };
    }

    // Patch MockBinding.createPort so that `SerialPortMock.binding.createPort
    // ('MOCK_PORT')` (which poolController calls) doesn't throw if called
    // twice. We do this once, regardless of how many simulators spin up.
    if (!RealBinding.createPort.__simPatched) {
        const origCreate = RealBinding.createPort.bind(RealBinding);
        RealBinding.createPort = (path: string, opts: any) => {
            try { origCreate(path, opts); } catch { /* port already exists — fine */ }
        };
        RealBinding.createPort.__simPatched = true;
    }

    /**
     * PatchedMock — substitutes for SerialPortMock. When poolController does
     * `new SerialPortMock(opts)`, it gets a SimulatedSerialPort bound to the
     * active simulator instead of a real SerialPortStream. SimulatedSerialPort
     * implements the same callback-style surface (open/close/write/drain + 'open'/
     * 'data'/'close' events) that Comms.ts actually uses in mock mode.
     *
     * Note: we do NOT set SimulatedSerialPort.prototype = RealMock.prototype
     * (that would clobber SimulatedSerialPort's own methods). The consumer-side
     * `instanceof SerialPortMock` check at Comms.ts:867 is guarded by
     * `this.mock === true` — and if `instanceof` is false, the fallback path
     * uses the callback-style `port.write(bytes, cb)` API, which
     * SimulatedSerialPort implements directly. Either path works.
     */
    function PatchedMock(this: any, opts: any) {
        const sim = new SimulatedSerialPort({
            path: opts.path,
            baudRate: opts.baudRate,
            dataBits: opts.dataBits,
            parity: opts.parity,
            stopBits: opts.stopBits,
            autoOpen: opts.autoOpen,
        });
        sim.simulator = simulator;
        ports.push(sim);
        return sim;
    }
    // Inherit static props (`binding`, `list`) so callers that reach
    // `SerialPortMock.binding.createPort(...)` (Comms.ts:668) still work.
    PatchedMock.binding = RealBinding;
    PatchedMock.list = RealMock.list;

    // Replace on the **inner** module. The outer `serialport.SerialPortMock`
    // getter will resolve to this on the next access.
    innerMockModule.SerialPortMock = PatchedMock;

    return {
        restore: () => {
            innerMockModule.SerialPortMock = originalShim!.realMock;
        },
        ports,
    };
}

async function pickFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const addr = srv.address();
            const port = typeof addr === 'object' && addr ? addr.port : 0;
            srv.close(() => resolve(port));
        });
    });
}

/** Internal: wait for the HTTP server to start accepting connections. */
async function waitForHttp(port: number, timeoutMs = 8000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const ok = await new Promise<boolean>(resolve => {
            const sock = net.connect(port, '127.0.0.1');
            sock.once('connect', () => { sock.end(); resolve(true); });
            sock.once('error', () => resolve(false));
        });
        if (ok) return;
        await new Promise(r => setTimeout(r, 50));
    }
    throw new Error(`SimulatorHarness: HTTP server did not start on port ${port} within ${timeoutMs}ms`);
}

/**
 * Boot poolController in simulate mode against a single RS-485 port.
 *
 * @param testName unique key for the simulator registry (typically the test name).
 * @param opts simulator configuration.
 */
export async function start(testName = 'default', opts: SimulatorOptions = {}): Promise<SimulatorHandle> {
    if (registries.has(testName)) {
        throw new Error(`SimulatorHarness: a simulator named "${testName}" is already running`);
    }
    const httpPort = opts.httpPort ?? await pickFreePort();

    // 1. Pre-config the controller before it boots so it opens in mock mode
    //    and binds the HTTP server to our picked port.
    const ctrl = config.getSection('controller');
    (ctrl as any).comms = (ctrl as any).comms ?? {};
    const ctrlComms = (ctrl as any).comms;
    ctrlComms.type = 'mock';
    ctrlComms.portId = 0;
    ctrlComms.enabled = true;
    ctrlComms.mock = true;
    ctrlComms.rs485Port = 'MOCK_PORT';
    ctrlComms.inactivityRetry = 0;
    config.setSection('controller', ctrl);

    const web = config.getSection('web');
    (web as any).servers = (web as any).servers ?? {};
    const ws: any = (web as any).servers;
    ws.http = ws.http ?? {};
    ws.http.enabled = true;
    ws.http.ip = '127.0.0.1';
    ws.http.port = httpPort;
    ws.http.httpsRedirect = false;
    ws.http.authentication = 'none';
    if (!ws.mdns) ws.mdns = { enabled: false };
    if (!ws.ssdp) ws.ssdp = { enabled: false };
    if (ws.https) ws.https.enabled = false;
    config.setSection('web', web);

    // 2. Build the simulator, patch serialport, store in registry.
    const simulator = new PanelSimulator(opts);
    const shim = installSerialPortShim(simulator);
    registries.set(testName, { simulator, ports: shim.ports });

    // 3. Boot poolController. The init order in app.ts is:
    //    config -> logger -> sys -> state -> webApp -> conn -> sys.start
    const { initAsync } = require('../../app');
    await initAsync();

    // 4. Wait for HTTP to be listening.
    await waitForHttp(httpPort);

    // 5. Connect a socket.io client.
    const socket = sockClient(`http://127.0.0.1:${httpPort}`, {
        reconnection: false,
        transports: ['websocket', 'polling'],
        timeout: 5000,
    });
    await new Promise<void>((resolve, reject) => {
        const t = setTimeout(
            () => reject(new Error('socket.io client failed to connect within 5s')),
            5000);
        socket.once('connect', () => { clearTimeout(t); resolve(); });
        socket.once('connect_error', err => { clearTimeout(t); reject(err); });
    });

    const waitForState = (predicate: (s: typeof state) => boolean | Promise<boolean>,
                           timeoutMs = 5000) =>
        new Promise<void>((resolve, reject) => {
            const start = Date.now();
            const tick = async () => {
                try {
                    const ok = await predicate(state);
                    if (ok) return resolve();
                } catch (err) {
                    return reject(err);
                }
                if (Date.now() - start >= timeoutMs) {
                    return reject(new Error(
                        `waitForState timed out after ${timeoutMs}ms`));
                }
                setTimeout(tick, 25);
            };
            tick();
        });

    /**
     * Teardown: disconnect socket + close simulator + restore serialport shim.
     *
     * IMPORTANT: do NOT call app.stopAsync() between tests — it ends with
     * `finally { process.exit(); }`, which would kill the test runner and
     * prevent later subtests from running. The full shutdown is deferred to
     * a once-only `beforeExit` handler installed by the test runner (or the
     * module-level setUp process hook).
     */
    const stop = async () => {
        try { socket.disconnect(); } catch { /* ignore */ }
        try { shim.restore(); } catch { /* ignore */ }
        try { simulator.close(); } catch { /* ignore */ }
        registries.delete(testName);
    };

    return {
        socket,
        httpPort,
        simulator,
        simulatedPorts: shim.ports,
        waitForState,
        stop,
    };
}

/** Stop a simulator by name (useful in `afterEach`). */
export async function stop(testName = 'default'): Promise<void> {
    const reg = registries.get(testName);
    if (!reg) return;
    registries.delete(testName);
    reg.simulator.close();
}

/** Direct registry access for advanced tests. */
export function getSimulator(testName = 'default'): PanelSimulator | undefined {
    return registries.get(testName)?.simulator;
}

/**
 * Namespace export so callers can write `SimulatorHarness.start(...)` and
 * `SimulatorHarness.fullTeardown()` — matches the convention in the rest of
 * the poolController codebase.
 */
export const SimulatorHarness = {
    start,
    stop,
    getSimulator,
    fullTeardown,
    installExitHook,
};

/**
 * Module-level one-shot teardown. Tests should call this from a final
 * `after(...)` hook (or the test runner's `afterAll`). It runs the full
 * `app.stopAsync()` exactly once and lets the process exit cleanly so
 * `npm test` returns 0.
 *
 * app.stopAsync() ends with `finally { process.exit(); }` — calling it
 * between subtests would kill the runner. Defer to end-of-suite.
 */
let fullTeardownRan = false;
export async function fullTeardown(): Promise<void> {
    if (fullTeardownRan) return;
    fullTeardownRan = true;
    for (const reg of registries.values()) {
        try { reg.simulator.close(); } catch { /* ignore */ }
    }
    registries.clear();
    try {
        const { stopAsync } = require('../../app');
        await stopAsync();
    } catch { /* ignore — process.exit() inside stopAsync handles the rest */ }
}

/**
 * Install a process-level hook that calls fullTeardown() on natural exit.
 * Lets `npm test` exit 0 without the test runner needing to know about the
 * teardown contract.
 */
export function installExitHook(): void {
    if ((installExitHook as any).__installed) return;
    (installExitHook as any).__installed = true;
    const onExit = async () => {
        try { await fullTeardown(); } catch { /* ignore */ }
    };
    process.once('beforeExit', () => { void onExit(); });
}