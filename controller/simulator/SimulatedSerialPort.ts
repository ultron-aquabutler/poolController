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
 * SimulatedSerialPort — drop-in replacement for SerialPortMock.
 *
 * Implements just enough of the `serialport` interface that RS485Port uses:
 *   - open(cb) / close(cb)
 *   - on('open' | 'close' | 'error' | 'data', cb)
 *   - write(buffer, cb)
 *   - drain(cb)
 *   - isOpen
 *   - .path, .baudRate, .port.openOptions (for logging)
 *
 * Writes are passed to a `PanelSimulator`; the simulator's responses
 * are emitted asynchronously as 'data' events.
 *
 * No native bindings — runs identically on x86 linux CI and aarch64 RPi.
 */

import { EventEmitter } from 'events';
import { PanelSimulator } from './PanelSimulator';

export interface SimulatedSerialPortOptions {
    path: string;
    baudRate?: number;
    dataBits?: number;
    parity?: 'none' | 'even' | 'odd' | 'mark' | 'space';
    stopBits?: number;
    autoOpen?: boolean;
}

export class SimulatedSerialPort extends EventEmitter {
    public readonly path: string;
    public readonly baudRate: number;
    public isOpen: boolean = false;
    public port: {
        openOptions: { dataBits: number; parity: string; stopBits: number; baudRate: number };
    };

    /** The panel that responds to commands. Set by SimulatorHarness. */
    public simulator: PanelSimulator | null = null;

    private dataBits: number;
    private parity: string;
    private stopBits: number;

    constructor(opts: SimulatedSerialPortOptions) {
        super();
        this.path = opts.path;
        this.baudRate = opts.baudRate ?? 9600;
        this.dataBits = opts.dataBits ?? 8;
        this.parity = opts.parity ?? 'none';
        this.stopBits = opts.stopBits ?? 1;
        this.port = {
            openOptions: {
                dataBits: this.dataBits,
                parity: this.parity,
                stopBits: this.stopBits,
                baudRate: this.baudRate,
            }
        };
        if (opts.autoOpen) {
            // Defer to next tick so listeners can be attached first.
            setImmediate(() => this.open(() => { /* swallow */ }));
        }
    }

    public open(cb?: (err: Error | null) => void): void {
        setImmediate(() => {
            if (this.isOpen) {
                cb?.(new Error('Port is already open'));
                return;
            }
            this.isOpen = true;
            this.emit('open');
            cb?.(null);
        });
    }

    public close(cb?: (err: Error | null) => void): void {
        setImmediate(() => {
            if (!this.isOpen) {
                cb?.(null);
                return;
            }
            this.isOpen = false;
            this.emit('close');
            cb?.(null);
        });
    }

    /** Simulate a serial-port drain — there is no underlying buffer so this is instant. */
    public drain(cb: (err?: Error) => void): void {
        setImmediate(() => cb());
    }

    public write(buffer: Buffer | number[], cb?: (err?: Error | null) => void): void {
        if (!this.isOpen) {
            cb?.(new Error('Port is not open'));
            return;
        }
        const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
        // Defer to next tick so callers' onComplete callbacks always run AFTER
        // the simulated response (which is also on a nextTick).
        setImmediate(() => {
            try {
                if (this.simulator) {
                    const responses = this.simulator.feed(this.path, buf);
                    if (responses.length) {
                        // Emit each response chunk in order with a tiny gap so
                        // poolController has time to process the previous one.
                        responses.forEach((r, i) => {
                            setTimeout(() => {
                                if (this.isOpen) this.emit('data', r);
                            }, i * 5);
                        });
                    }
                }
                cb?.(null);
            } catch (err) {
                cb?.(err as Error);
            }
        });
    }

    /** Public helper for tests/harness — push raw bytes as if they came
     * from a panel (simulates a button press on the real hardware). */
    public injectIncoming(chunk: Buffer): void {
        if (this.isOpen) this.emit('data', chunk);
    }
}