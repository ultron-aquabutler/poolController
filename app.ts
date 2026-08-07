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
// add source map support for .js to .ts files
//require('source-map-support').install();
import 'source-map-support/register';

import { logger } from "./logger/Logger";
import { config } from "./config/Config";
import { conn } from "./controller/comms/Comms";
import { sys } from "./controller/Equipment";

import { state } from "./controller/State";
import { webApp, REMInterfaceServer } from "./web/Server";
import * as readline from 'readline';
import { sl } from './controller/comms/ScreenLogic'

/**
 * Parse simple --key / --key=value CLI flags from process.argv.
 * Recognised flags:
 *   --simulate                 Force every RS-485 comms port into mock mode and
 *                              use the in-process PanelSimulator. No real
 *                              serial hardware required. Designed for dev/CI.
 *   --simulate-port=<portId>   Only flip the named port into mock mode (can
 *                              be repeated). Defaults to portId 0.
 *   --simulate-config=<path>   Load initial panel state from a JSON file
 *                              instead of the default EasyTouch layout.
 *   --help                     Print recognised flags and exit.
 */
export function parseCliFlags(argv: string[]): {
    simulate: boolean;
    simulatePorts: number[];
    simulateConfigPath?: string;
    showHelp: boolean;
} {
    const result = {
        simulate: false,
        simulatePorts: [] as number[],
        simulateConfigPath: undefined as string | undefined,
        showHelp: false,
    };
    for (const arg of argv) {
        if (arg === '--simulate') {
            result.simulate = true;
            continue;
        }
        if (arg === '--help' || arg === '-h') {
            result.showHelp = true;
            continue;
        }
        if (arg.startsWith('--simulate-port=')) {
            const v = parseInt(arg.split('=')[1], 10);
            if (!isNaN(v)) result.simulatePorts.push(v);
            continue;
        }
        if (arg.startsWith('--simulate-config=')) {
            result.simulateConfigPath = arg.split('=')[1];
            continue;
        }
    }
    return result;
}

export function printHelp(): void {
    /* eslint-disable no-console */
    console.log(`nodejs-poolController — simulate mode flags`);
    console.log(`  --simulate                  Boot against the in-process PanelSimulator.`);
    console.log(`                              No real serial hardware required.`);
    console.log(`  --simulate-port=<portId>    Only flip a specific comms port to mock.`);
    console.log(`  --simulate-config=<path>    Load initial panel state from JSON.`);
    console.log(`  --help / -h                 Show this help.`);
    /* eslint-enable no-console */
}

/**
 * Apply CLI flags to the loaded config. Must be called AFTER config.init()
 * but BEFORE any RS-485 ports are opened.
 */
export function applyCliFlags(flags: ReturnType<typeof parseCliFlags>): void {
    if (flags.showHelp) {
        printHelp();
    }
    if (!flags.simulate && flags.simulatePorts.length === 0) return;
    const ctrl = config.getSection('controller') as any;
    const sections: string[] = [];
    for (const k of Object.keys(ctrl)) {
        if (k.startsWith('comms')) sections.push(k);
    }
    if (sections.length === 0) sections.push('comms');

    for (const sec of sections) {
        const p = ctrl[sec];
        const isTargeted = flags.simulate ||
            flags.simulatePorts.includes(p?.portId ?? 0);
        if (!isTargeted) continue;
        p.type = 'mock';
        p.mock = true;
        p.enabled = true;
        p.rs485Port = 'MOCK_PORT';
        p.inactivityRetry = 0;
        config.setSection(`controller.${sec}`, p);
    }
}

export async function initAsync() {
    try {
        await config.init();
        await logger.init();
        const flags = parseCliFlags(process.argv.slice(2));
        if (process.env.POOL_SIMULATE === '1' || process.env.POOL_SIMULATE === 'true') flags.simulate = true;
        applyCliFlags(flags);
        if (flags.simulateConfigPath) {
            try {
                const fs = require('fs');
                const json = JSON.parse(
                    fs.readFileSync(flags.simulateConfigPath, 'utf8'));
                config.setSection('simulator', { initialState: json });
            } catch (err) {
                (logger as any)?.error?.(
                    `Could not load --simulate-config: ${err.message}`) ??
                    console.error(`Could not load --simulate-config: ${err.message}`);
            }
        }
        await sys.init();
        await state.init();
        await webApp.init();
        await conn.initAsync();
        await sys.start();
        await webApp.initAutoBackup();
        await sl.openAsync();
    } catch (err) { console.log(`Error Initializing nodejs-PoolController ${err.message}`);  }
}

export async function startPacketCapture(bResetLogs: boolean) {
    try {
        let log = config.getSection('log');
        log.app.captureForReplay = true;
        config.setSection('log', log);
        logger.startCaptureForReplay(bResetLogs);
        if (bResetLogs){
            sys.resetSystem();
        }
        
        // Start packet capture on the REM server
        await REMInterfaceServer.startPacketCaptureOnRemServer();
    }
    catch (err) {
        console.error(`Error starting replay: ${ err.message }`);
    }
}
export async function stopPacketCaptureAsync() {
    let log = config.getSection('log');
    log.app.captureForReplay = false;
    config.setSection('log', log);
    
    // Stop packet capture on the REM server and collect its logs
    let remLogs = await REMInterfaceServer.stopPacketCaptureOnRemServer();
    
    // Pass REM logs to the logger for inclusion in the backup
    return logger.stopCaptureForReplayAsync(remLogs);
}
export async function stopAsync(): Promise<void> {
    try {
        console.log('Shutting down open processes');
        await webApp.stopAutoBackup();
        await sys.stopAsync();
        await state.stopAsync();
        await conn.stopAsync();
        await sl.closeAsync();
        await webApp.stopAsync();
        await config.updateAsync();
        await logger.stopAsync();
        // RKS: Uncomment below to see the shutdown process
        //await new Promise<void>((resolve, reject) => { setTimeout(() => { resolve(); }, 20000); });
    }
    catch (err) {
        console.error(`Error stopping processes: ${ err.message }`);
    }
    finally {
        process.exit();
    }
}
if (process.platform === 'win32') {
    let rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.on('SIGINT', async function () {
        try { await stopAsync(); } catch (err) { console.log(`Error shutting down processes ${err.message}`); }
    });
}
else {
    process.stdin.resume();
    process.on('SIGINT', async function () {
        try { return await stopAsync(); } catch (err) { console.log(`Error shutting down processes ${err.message}`); }
    });
}
if (typeof process === 'object') {
    process.on('unhandledRejection', (error: Error, promise) => {
        console.group('unhandled rejection');
        console.error("== Node detected an unhandled rejection! ==");
        console.error(error.message);
        console.error(error.stack);
        console.groupEnd();
    });
}
( async () => { await initAsync() })();