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
 * PanelSimulator — virtual Jandy RS-485 panel.
 *
 * Receives commands encoded as raw bytes (the way the controller sees them
 * after they leave the SerialPortMock), updates its in-memory state, and
 * produces response byte arrays that the harness feeds back to the
 * controller via the SerialPortMock binding.
 *
 * The simulator is intentionally minimal — it implements just enough
 * of the Jandy protocol for poolController's default EasyTouch setup
 * to round-trip cleanly:
 *   - Ack (action 1) for any SET command
 *   - Date/Time (action 5) reply
 *   - Custom Name (action 10) reply
 *   - Set Circuit (action 134) — flips state and acks
 *   - Set Heat Mode / Setpoint (action 136) — updates heater and acks
 *   - Set Settings (action 168) — updates settings and acks
 *   - Set Delay (action 131) — updates delay and acks
 *   - Set Pump Config (action 152) — acks
 *   - Set Solar / Heat Pump (action 162) — acks
 *   - Status push (action 2) on the configured heartbeat interval
 *
 * For unknown actions the simulator logs a warning and emits an Ack, so
 * poolController never hangs waiting for a response.
 */

import { EventEmitter } from 'events';
import { Protocol } from '../comms/messages/Messages';
import {
    CommandHandler, CircuitState, DecodedCommand,
    defaultPanelState, PanelStateSnapshot
} from './PanelState';

export interface PanelSimulatorOptions {
    /** Initial state. Defaults to a basic 8-circuit EasyTouch layout. */
    initialState?: PanelStateSnapshot;
    /** Source address the panel uses when replying. Default 16 (EasyTouch OCP). */
    panelAddress?: number;
    /** Controller address the simulator should target. Default 15 (plugin). */
    controllerAddress?: number;
    /** Optional heart-beat: how often (ms) to push a status update. 0 = off. */
    heartbeatIntervalMs?: number;
}

/**
 * Decode a raw RS-485 broadcast frame written by poolController.
 *
 * The frame layout is:
 *   [0xFF, 0x00, 0xFF,            ]  preamble
 *   [0xA5, sub, dest, source, action, datalen, payload..., chkHi, chkLo]
 *
 * For Chlorinator protocol (no preamble, different header positions).
 */
function decodeCommand(packet: Buffer): DecodedCommand | null {
    if (packet.length < 6) return null;

    // Broadcast / pump / heater / intellivalve: starts with FF 00 FF preamble.
    if (packet[0] === 0xff && packet[1] === 0x00 && packet[2] === 0xff) {
        // Minimum: 3 preamble + 6 header (sub/dest/src/action/datalen) + 0 payload + 2 chk = 11
        if (packet.length < 11) return null;
        const sub = packet[4];
        const dest = packet[5];
        const source = packet[6];
        const action = packet[7];
        const datalen = packet[8];
        const payload: number[] = [];
        for (let i = 0; i < datalen && i + 9 < packet.length - 2; i++) {
            payload.push(packet[9 + i]);
        }
        const short = packet
            .slice(4, 9 + datalen)
            .toString('hex')
            .match(/.{2}/g)
            ?.join(' ') ?? packet.toString('hex');
        return {
            receivedAt: new Date(),
            destination: dest,
            source,
            action,
            protocol: Protocol.Broadcast,
            payload,
            shortPacket: `[${short}]`
        };
    }

    // Chlorinator: header [0x10, 0x02, dest, action, payload..., checksum, 0x10, 0x03]
    if (packet[0] === 0x10 && packet[1] === 0x02) {
        const dest = packet[2];
        const action = packet[3];
        // Term is the last two bytes: [chk, 0x10, 0x03]
        const payload: number[] = [];
        for (let i = 4; i < packet.length - 3; i++) payload.push(packet[i]);
        return {
            receivedAt: new Date(),
            destination: dest,
            source: 0x0f,
            action,
            protocol: Protocol.Chlorinator,
            payload,
            shortPacket: packet.toString('hex').match(/.{2}/g)?.join(' ') ?? ''
        };
    }

    return null;
}

/** Encode a broadcast response frame. */
function encodeBroadcastResponse(
    dest: number, source: number, action: number, payload: number[]): Buffer {
    const frame: number[] = [0xff, 0x00, 0xff, 0xa5, 0x00, dest, source, action, payload.length];
    for (const b of payload) frame.push(b);
    // Compute checksum over header + payload.
    let sum = 0;
    for (let i = 3; i < frame.length; i++) sum += frame[i];
    frame.push(Math.floor(sum / 256) & 0xff);
    frame.push(sum & 0xff);
    return Buffer.from(frame);
}

/** Encode an Ack (action 1) frame in response to a SET command. */
function encodeAck(actionToAck: number, dest: number, source: number): Buffer {
    return encodeBroadcastResponse(dest, source, 1, [actionToAck]);
}

export class PanelSimulator extends EventEmitter {
    public state: PanelStateSnapshot;
    /** Every decoded command in arrival order — useful for assertions. */
    public commands: DecodedCommand[] = [];
    /** Custom handler overrides — keyed by action code. */
    public handlers: Map<number, CommandHandler> = new Map();

    private panelAddress: number;
    private controllerAddress: number;
    private heartbeatTimer: NodeJS.Timeout | null = null;
    /** Buffers keyed by portPath for split packet reassembly. */
    private buffers: Map<string, Buffer> = new Map();

    constructor(opts: PanelSimulatorOptions = {}) {
        super();
        this.state = opts.initialState ?? defaultPanelState();
        this.panelAddress = opts.panelAddress ?? 16;
        this.controllerAddress = opts.controllerAddress ?? 15;
        const interval = opts.heartbeatIntervalMs ?? 0;
        if (interval > 0) {
            this.heartbeatTimer = setInterval(() => this.tickHeartbeat(), interval);
        }
    }

    /** Stop any background timers. */
    public close(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        this.buffers.clear();
        this.removeAllListeners();
    }

    /**
     * Feed a chunk of raw bytes the controller just wrote. Returns the
     * response bytes the simulator wants the controller to receive next.
     */
    public feed(portPath: string, chunk: Buffer): Buffer[] {
        // Reassemble split packets.
        let acc = this.buffers.get(portPath) ?? Buffer.alloc(0);
        acc = Buffer.concat([acc, chunk]);
        const responses: Buffer[] = [];

        while (acc.length > 0) {
            // Find the end of the current packet. Broadcast ends with chkHi/chkLo
            // (last 2 bytes). Chlorinator ends with 0x10 0x03.
            let packetEnd = -1;
            if (acc.length >= 3 && acc[acc.length - 2] === 0x10 && acc[acc.length - 1] === 0x03) {
                packetEnd = acc.length;
            } else if (acc.length >= 2) {
                // Broadcast: need >= 6 header bytes + payload + 2 chk bytes.
                // Minimum packet length: 3 preamble + 6 header + 0 payload + 2 chk = 11.
                if (acc.length >= 11 && acc[0] === 0xff && acc[1] === 0x00 && acc[2] === 0xff) {
                    const datalen = acc[8];
                    packetEnd = 3 + 6 + datalen + 2;
                    if (packetEnd > acc.length) packetEnd = -1;
                }
            }
            if (packetEnd <= 0 || packetEnd > acc.length) {
                // Incomplete — wait for more bytes.
                break;
            }
            const packet = acc.slice(0, packetEnd);
            acc = acc.slice(packetEnd);
            const decoded = decodeCommand(packet);
            if (decoded) {
                this.commands.push(decoded);
                this.emit('command', decoded);
                const handler = this.handlers.get(decoded.action);
                if (handler) {
                    handler(decoded);
                }
                const resp = this.handle(decoded);
                if (resp) responses.push(...resp);
            }
        }

        this.buffers.set(portPath, acc);
        return responses;
    }

    /** Reset state and command history. Useful between tests. */
    public reset(state?: PanelStateSnapshot): void {
        this.state = state ?? defaultPanelState();
        this.commands = [];
        this.buffers.clear();
    }

    /** Convenience accessors for tests. */
    public getCircuit(id: number): CircuitState | undefined {
        return this.state.circuits.find(c => c.id === id);
    }

    public setCircuit(id: number, isOn: boolean): void {
        const c = this.getCircuit(id);
        if (c) c.isOn = isOn;
    }

    /** Override or augment the panel's response for a given action code.
     * Useful in tests when a scenario requires custom protocol behaviour. */
    public onAction(action: number, handler: CommandHandler): void {
        this.handlers.set(action, handler);
    }

    /** Push a synthetic status packet to the controller (e.g. for tests
     * that want to simulate a button press on the physical panel). */
    public pushStatus(): Buffer[] {
        const payload = this.encodeStatusPayload();
        return [encodeBroadcastResponse(
            this.controllerAddress, this.panelAddress, 2, payload)];
    }

    // -- internal --

    private tickHeartbeat(): void {
        const responses = this.pushStatus();
        if (responses.length) this.emit('data', responses);
    }

    /** Mutate state based on the command and produce response packets. */
    private handle(cmd: DecodedCommand): Buffer[] | null {
        // All SET commands get an Ack from the panel.
        const SET_ACTIONS = new Set([
            131, 133, 134, 136, 138, 139, 144, 145, 146, 147, 150, 152,
            153, 155, 157, 158, 160, 161, 162, 163, 167, 168
        ]);

        // -- GET commands --
        switch (cmd.action) {
            case 197: { // get date/time
                const now = new Date();
                const payload = [
                    now.getHours(), now.getMinutes(), now.getDay() + 1,
                    now.getDate(), now.getMonth() + 1, now.getFullYear() - 2000, 0
                ];
                return [encodeBroadcastResponse(cmd.source, this.panelAddress, 5, payload)];
            }
            case 202: { // get custom name
                const id = cmd.payload[0] ?? 0;
                const circuit = this.state.circuits.find(c => c.id === id);
                const name = circuit?.name ?? `CustomName${id}`;
                const buf = Buffer.alloc(11);
                buf.write(name.slice(0, 11));
                return [encodeBroadcastResponse(cmd.source, this.panelAddress, 10, [id, ...buf])];
            }
            case 203: { // get circuit functions (broadcast with circuit table)
                const payload = new Array(20).fill(0);
                for (const c of this.state.circuits) {
                    if (c.id - 1 < 20) payload[c.id - 1] = c.functionId;
                }
                return [encodeBroadcastResponse(cmd.source, this.panelAddress, 11, payload)];
            }
            case 232: { // get settings
                const payload = new Array(10).fill(0);
                payload[3] = this.state.chlorinator.isActive ? 1 : 0;
                payload[4] = this.state.heater.mode;
                return [encodeBroadcastResponse(cmd.source, this.panelAddress, 40, payload)];
            }
        }

        // -- SET commands (mutate state then ack) --
        if (SET_ACTIONS.has(cmd.action)) {
            this.mutate(cmd);
            return [encodeAck(cmd.action, cmd.source, this.panelAddress)];
        }

        // Unknown action — emit an ack so the controller doesn't hang.
        return [encodeAck(cmd.action, cmd.source, this.panelAddress)];
    }

    private mutate(cmd: DecodedCommand): void {
        switch (cmd.action) {
            case 134: { // set circuit
                // payload: [circuitId, isOn, ...]
                const id = cmd.payload[0];
                const isOn = !!(cmd.payload[1]);
                this.setCircuit(id, isOn);
                break;
            }
            case 136: { // set heat mode / setpoint
                // payload varies; we just touch the heater body setpoint.
                if (cmd.payload.length >= 3) {
                    this.state.heater.body = cmd.payload[1];
                }
                break;
            }
            case 131: // set delay
            case 163: // set delay
                this.emit('delay', cmd.payload);
                break;
            case 168: // set settings
                if (cmd.payload.length >= 1) this.state.heater.mode = cmd.payload[0];
                break;
        }
    }

    private encodeStatusPayload(): number[] {
        const payload = new Array(29).fill(0);
        const now = new Date();
        payload[0] = now.getHours();
        payload[1] = now.getMinutes();
        payload[9] = this.state.heater.mode;
        payload[10] = 0; // valve mask
        payload[12] = 0; // delay
        payload[14] = this.state.heater.waterSensor1;
        payload[18] = this.state.heater.air;
        // Pack circuit state into bytes 2..8 (1 bit per circuit).
        for (const c of this.state.circuits) {
            if (c.isOn && c.id >= 1 && c.id <= 40) {
                const byteIdx = 2 + Math.floor((c.id - 1) / 8);
                const bit = (c.id - 1) % 8;
                if (byteIdx < payload.length) {
                    payload[byteIdx] |= (1 << bit);
                }
            }
        }
        this.state.statusTick++;
        return payload;
    }
}