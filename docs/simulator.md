# Simulator

## How to Run

```bash
npm run start:simulate
```

This builds the TypeScript (`npm run build`) and runs `node dist/app.js --simulate`. The `--simulate` flag forces every RS-485 comms port into mock mode. Instead of opening a real serial port, the app uses an in-process `PanelSimulator` that responds to protocol commands the same way real hardware would.

The HTTP server and Socket.IO still start normally, so you can interact with the web UI or API while the simulator handles all serial traffic.

## How to Test

```bash
npm run test:simulate
# or simply
npm test
```

Both commands run the same test suite:

```
node --test --require ./tests/ts-node-register.js tests/simulator/*.test.ts
```

Six integration tests verify the simulator harness:

1. **Boots in simulate mode** — HTTP server is listening, Socket.IO client connects, SimulatedSerialPort instances are created
2. **PanelSimulator acks SET circuit (134) commands** — verifies the mock panel responds to circuit on/off commands
3. **waitForState() resolves when predicate is truthy** — tests the state-waiting utility used in integration tests
4. **Multiple SET commands mutate panel state** — sends several circuit commands and verifies final state
5. **Simulator tracks every decoded command** — ensures command history is recorded in arrival order
6. **PanelSimulator returns date/time on GET 197** — verifies datetime query response

Tests use Node.js built-in `node:test` — no extra devDependencies required. Runs identically on x86 Linux CI and aarch64 Raspberry Pi.

## The `--simulate` Flag

The flag is parsed in `app.ts` via `parseCliFlags()`. When `--simulate` is present:

1. The flag sets `type: 'mock'` and `mock: true` on each RS-485 comms port in the config
2. At runtime, the serialport library detects the mock type and uses `SimulatedSerialPort` (from `controller/simulator/`)
3. `PanelSimulator` is instantiated in place of real hardware — it parses incoming RS-485 frames and returns appropriate responses

No new runtime dependencies were added. The simulator leverages `SerialPortMock` and `MessagesMock` already present in `controller/simulator/`. The mock serialport is a shim that the real `serialport` library recognizes when its type is set to `"mock"` in config.