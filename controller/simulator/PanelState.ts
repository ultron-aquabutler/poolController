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
 * PanelState — the virtual state of a Jandy RS-485 pool panel.
 *
 * The simulator maintains a small struct describing what the panel
 * "knows" right now: which circuits are on, the heater body/spa setpoints,
 * chlorinator output, and a tick counter so tests can detect status pushes.
 *
 * Tests can read `state.circuits[i].isOn`, push SET commands through the
 * controller's HTTP API, and assert that the simulated panel mutated.
 */

import { Protocol } from '../comms/messages/Messages';

export interface CircuitState {
    id: number;
    name: string;
    functionId: number;
    isOn: boolean;
}

export interface HeaterState {
    /** 0=off, 1=heater, 2=solar-preferred, 3=solar-only (per poolController's enum) */
    mode: number;
    body: number;     // body setpoint in degrees F
    spa: number;      // spa setpoint in degrees F
    air: number;      // last air temp
    waterSensor1: number;
}

export interface ChlorinatorState {
    isActive: boolean;
    output: number;   // 0-100%
}

export interface PanelStateSnapshot {
    circuits: CircuitState[];
    heater: HeaterState;
    chlorinator: ChlorinatorState;
    statusTick: number;
}

export type CommandHandler = (cmd: DecodedCommand) => void;

export interface DecodedCommand {
    receivedAt: Date;
    destination: number;
    source: number;
    action: number;
    protocol: Protocol;
    payload: number[];
    shortPacket: string;
}

/** Default EasyTouch layout — 8 aux circuits, gas heater, chlorinator. */
export function defaultPanelState(): PanelStateSnapshot {
    return {
        circuits: [
            { id: 1,  name: 'Spa',         functionId: 6,  isOn: false },
            { id: 2,  name: 'Jets',        functionId: 2,  isOn: false },
            { id: 3,  name: 'Pool Light',  functionId: 12, isOn: false },
            { id: 4,  name: 'Blower',      functionId: 9,  isOn: false },
            { id: 5,  name: 'Pool',        functionId: 1,  isOn: false },
            { id: 6,  name: 'Aux 6',       functionId: 0,  isOn: false },
            { id: 7,  name: 'Waterfall',   functionId: 14, isOn: false },
            { id: 8,  name: 'Cleaner',     functionId: 15, isOn: false },
        ],
        heater: {
            mode: 0,
            body: 80,
            spa: 102,
            air: 75,
            waterSensor1: 78,
        },
        chlorinator: {
            isActive: true,
            output: 50,
        },
        statusTick: 0,
    };
}