# nodejs-poolController Documentation

## Overview

nodejs-poolController (njsPC) is a comprehensive application designed to communicate with and control Pentair-compatible pool automation equipment. It bridges RS-485/ScreenLogic hardware to REST APIs, WebSockets, MQTT, InfluxDB, and custom rule engines.

**Version:** 8.3.0  
**License:** AGPL-3.0  
**Minimum Node.js:** 20.0.0

## Table of Contents

- [Architecture Overview](./architecture.md)
- [Root Level Files](./root-files.md)
- [Configuration System](./config-system.md)
- [Logger System](./logger-system.md)
- [Controller System](./controller-system.md)
- [Web Server & Interfaces](./web-system.md)
- [Mock/Testing System](./anslq25-system.md)
- [Build & Development](./development.md)

## Quick Start

### Prerequisites
- Node.js v20.0.0 or higher
- npm 8.0.0 or higher
- RS-485 adapter or ScreenLogic connection (for hardware control)

### Installation
```bash
# Clone the repository
git clone https://github.com/tagyoureit/nodejs-poolController.git
cd nodejs-poolController

# Install dependencies
npm install

# Build TypeScript
npm run build

# Start the application
npm start
```

### First Run
On first run, the application will:
1. Create a `config.json` from `defaultConfig.json` if it doesn't exist
2. Create necessary folders (`/data`, `/logs`, `/backups`)
3. Initialize the logger, equipment system, and web server
4. Attempt to connect to pool equipment via RS-485 or ScreenLogic

## Core Concepts

### Equipment Types Supported
- **Controllers:** IntelliCenter, IntelliTouch, EasyTouch, SunTouch, AquaLink, Nixie (standalone)
- **Pumps:** IntelliFlow VS/VSF/VF, relay-controlled pumps
- **Chlorinators:** IntelliChlor, Aqua-Rite, and OEM brands
- **Heaters:** Gas, Solar, Heat Pump
- **Chemistry:** IntelliChem, REM (Relay Equipment Manager)
- **Valves:** IntelliValve support

### Communication Methods
- **RS-485:** Direct serial communication with pool equipment (preferred)
- **ScreenLogic:** Network-based communication using Pentair's ScreenLogic protocol
- **Mock:** Simulated equipment for testing

### External Interfaces
- **HTTP/HTTPS REST API:** JSON-based control and monitoring
- **WebSockets:** Real-time state updates
- **MQTT:** Integration with home automation systems
- **InfluxDB:** Time-series data logging
- **Rules Engine:** Custom automation logic
- **REM Interface:** Hardware relay control

## Architecture Layers

### 1. Configuration Layer (`config/`)
Manages application configuration with hot-reload support, environment variable overrides, and automatic backup/recovery.

### 2. Logger Layer (`logger/`)
Winston-based logging with packet capture, replay capabilities, and time-series data logging.

### 3. Controller Layer (`controller/`)
Core equipment management including:
- Protocol communication (`comms/`)
- Equipment state management (`Equipment.ts`, `State.ts`)
- Board-specific implementations (`boards/`)
- Nixie standalone equipment support (`nixie/`)

### 4. Web Layer (`web/`)
HTTP servers, WebSocket handlers, and external integrations:
- REST API routes (`services/`)
- Interface bindings (`interfaces/`)
- Socket.IO real-time communication

### 5. Mock Layer (`anslq25/`)
Testing infrastructure for simulating pool equipment without hardware.

## Key Files

| File | Purpose |
|------|---------|
| `app.ts` | Application entry point and initialization sequence |
| `package.json` | NPM dependencies and build scripts |
| `tsconfig.json` | TypeScript compiler configuration |
| `defaultConfig.json` | Default configuration template |
| `Dockerfile` | Container build instructions |
| `docker-compose.yml` | Multi-container orchestration |
| `balena.yml` | Balena fleet / open-balena service manifest |
| [`docs/balena.md`](./balena.md) | Balena deployment guide (Raspberry Pi) |

## Data Persistence

### Configuration Files
- `/config.json` - User configuration (auto-created from defaults)
- `/defaultConfig.json` - Default settings template

### Runtime Data
- `/data/poolConfig.json` - Discovered equipment configuration
- `/data/poolState.json` - Current equipment state

### Logs & Backups
- `/logs/` - Application and packet logs
- `/backups/` - Automatic configuration backups

## Getting Help

- **GitHub Discussions:** [https://github.com/tagyoureit/nodejs-poolController/discussions](https://github.com/tagyoureit/nodejs-poolController/discussions)
- **Wiki:** [https://github.com/tagyoureit/nodejs-poolController/wiki](https://github.com/tagyoureit/nodejs-poolController/wiki)
- **Issue Tracker:** [https://github.com/tagyoureit/nodejs-poolController/issues](https://github.com/tagyoureit/nodejs-poolController/issues)

## Contributing

See [CONTRIBUTING.md](../CONTRIBUTING.md) for contribution guidelines and [.github/copilot-instructions.md](../.github/copilot-instructions.md) for AI-assisted development guidelines.
