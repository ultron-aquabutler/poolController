# Root Level Files Documentation

This document describes all the files in the root directory of the nodejs-poolController project.

## Core Application Files

### `app.ts`
**Purpose:** Application entry point and initialization orchestrator

**Key Functions:**
- `initAsync()` - Initializes all subsystems in the correct order:
  1. Configuration system (`config.init()`)
  2. Logger system (`logger.init()`)
  3. Equipment system (`sys.init()`)
  4. State system (`state.init()`)
  5. Web server (`webApp.init()`)
  6. RS-485 communications (`conn.initAsync()`)
  7. Equipment startup (`sys.start()`)
  8. Auto-backup initialization (`webApp.initAutoBackup()`)
  9. ScreenLogic connection (`sl.openAsync()`)

- `startPacketCapture(bResetLogs: boolean)` - Enables packet capture mode for debugging
- `stopAsync()` - Gracefully shuts down all systems in reverse initialization order

**Signal Handlers:**
- SIGINT (Ctrl+C) - Triggers graceful shutdown
- Unhandled promise rejections - Logged for debugging

**Platform-Specific:**
- Windows: Uses readline interface for proper signal handling
- Unix/Linux: Direct process signal handling

---

### `sendSocket.js`
**Purpose:** Command-line utility for sending commands to a running nodejs-poolController instance

**Usage:**
```bash
node sendSocket.js <command> [arguments]
```

**Features:**
- Connects to localhost Socket.IO server
- Sends commands and displays responses
- Useful for scripting and automation

---

## Configuration Files

### `package.json`
**Purpose:** NPM package manifest and build configuration

**Key Scripts:**
- `npm start` - Build TypeScript and run the application
- `npm run start:cached` - Run without rebuilding (faster, for development)
- `npm run build` - Compile TypeScript to JavaScript (output to `/dist`)
- `npm run watch` - Watch mode for continuous compilation during development

**Dependencies:**
- **Core:** express, socket.io, serialport
- **Protocols:** mqtt, node-screenlogic
- **Storage:** influxdb-client
- **Discovery:** multicast-dns, node-ssdp
- **Logging:** winston
- **Utilities:** extend, jszip, multer

**DevDependencies:**
- TypeScript and compiler
- ESLint for code quality
- Type definitions (@types/*)

**Engine Requirements:**
- Node.js >= 20.0.0
- npm >= 8.0.0

---

### `tsconfig.json`
**Purpose:** TypeScript compiler configuration

**Key Settings:**
- **Target:** ES2020
- **Module:** CommonJS
- **Output:** `/dist` directory
- **Source Maps:** Enabled for debugging
- **Type Checking:** Strict mode disabled (allows gradual migration)
- **Type Roots:** Includes `node_modules/@types` and custom `types/` folder

**Compilation Options:**
- Allows JavaScript files
- Generates declaration files (.d.ts)
- Preserves const enums
- Experimental decorators enabled

---

### `defaultConfig.json`
**Purpose:** Default configuration template

**Structure:**
```json
{
  "controller": {
    "comms": { /* RS-485 settings */ },
    "screenlogic": { /* ScreenLogic settings */ },
    "txDelays": { /* Transmit pacing */ }
  },
  "web": {
    "servers": { /* HTTP/HTTPS servers */ },
    "interfaces": { /* MQTT, InfluxDB, etc. */ }
  },
  "log": {
    "app": { /* Application logging */ },
    "packet": { /* Packet logging */ }
  }
}
```

**Key Sections:**
- **controller:** Communication and protocol settings
- **web:** Server configurations and external interfaces
- **log:** Logging levels and capture settings
- **appVersion:** Automatically populated from package.json

**Note:** User settings are stored in `config.json` (auto-created). Never edit this file directly.

---

### `.eslintrc.json`
**Purpose:** ESLint code quality configuration

**Rules Configured:**
- Code style standards
- TypeScript-specific linting
- Import/export conventions
- Promise handling patterns

---

### `.gitignore`
**Purpose:** Specifies files Git should ignore

**Excluded Items:**
- `/node_modules/` - NPM dependencies
- `/dist/` - Compiled JavaScript
- `/data/` - Runtime equipment data
- `/logs/` - Log files
- `/backups/` - Backup archives
- `config.json` - User-specific configuration
- IDE and OS specific files

---

### `.npmrc`
**Purpose:** NPM configuration

**Settings:**
- Package installation preferences
- Registry configurations (if any)

---

## Build & Container Files

### `Dockerfile`
**Purpose:** Docker container build instructions

**Build Process:**
1. Base image: Node.js 20+ (configurable via `BASE_IMAGE` build-arg so
   balenalib variants can be substituted for balenaOS alignment)
2. Copy package files and install dependencies (works on both apk/alpine
   and apt-get/balenalib base images)
3. Copy source code
4. Build TypeScript (`npm run build`)
5. Expose port 4200 (HTTP) and 4201 (HTTPS)
6. Set startup command
7. Healthcheck is a TCP probe to port 4200

**Usage:**
```bash
docker build -t njspc .
docker run -p 4200:4200 -v /dev/ttyUSB0:/dev/ttyUSB0 njspc

# For a balenalib base image:
docker build -t njspc --build-arg BASE_IMAGE=balenalib/raspberry-pi-base:latest .
```

---

### `balena.yml`
**Purpose:** Single-service manifest for balenaCloud / open-balena fleets
(see [`docs/balena.md`](./balena.md) for the deployment walkthrough).

**Service Defined:**
- **poolController:** njsPC running on Raspberry Pi
  - Ports 4200 (HTTP) / 4201 (HTTPS) / 39500 (SmartThings) / 39501 (Hubitat)
  - RS-485 device bindings for `/dev/ttyUSB0` and `/dev/ttyACM0`
  - Named volumes for config, data, backups, logs, and custom bindings
  - Healthcheck pings `GET /` every 60s
  - Reads `POOL_RS485_PORT` env to point at the active adapter

**Volumes (persist on device, survive OTA):**
- `poolcontroller-config` - Editable `/app/config.json`
- `poolcontroller-data` - State & equipment snapshots
- `poolcontroller-backups` - Auto-backup archives
- `poolcontroller-logs` - Application logs
- `poolcontroller-bindings` - Custom integration bindings

**Environment Variables (service defaults; per-device overrides via
Device Variables in the balena dashboard):**
- `POOL_RS485_PORT` - RS-485 device node inside the container
- `POOL_NET_CONNECT` - Use TCP bridge instead of direct serial
- `POOL_NET_HOST` / `POOL_NET_PORT` - TCP bridge target
- `TZ` - Site timezone
- `NODE_ENV` - Always `production`
- `POOL_LATITUDE` / `POOL_LONGITUDE` - Set per-device to suppress
  heliotrope warnings

---

### `docker-compose.yml`
**Purpose:** Multi-container orchestration

**Services Defined:**
- **njspc:** Main pool controller service
  - Port 4200 (REST API)
  - Serial device mapping
  - Volume mounts for persistence
  - Environment variables for configuration

- **njspc-dash:** (Optional) Dashboard UI
  - Port 5150 (Web UI)
  - Connects to njspc backend
  - Separate data volumes

**Volumes:**
- `njspc-data` - Equipment configuration and state
- `njspc-logs` - Application logs
- `njspc-backups` - Configuration backups
- `njspc-bindings` - Custom integration bindings

**Environment Variables:**
- `TZ` - Timezone
- `NODE_ENV` - Environment (production/development)
- `POOL_NET_CONNECT` - Enable ScreenLogic network connection
- `POOL_NET_HOST` - ScreenLogic host
- `POOL_NET_PORT` - ScreenLogic port
- `POOL_LATITUDE` - Location latitude for heliotrope
- `POOL_LONGITUDE` - Location longitude for heliotrope

---

### `Gruntfile.js`
**Purpose:** Grunt task runner configuration (legacy)

**Tasks:**
- Banner generation for builds
- Potential build automation

**Note:** Modern builds primarily use npm scripts; Grunt is legacy.

---

## Documentation Files

### `README.md`
**Purpose:** Main project documentation

**Contents:**
- Project overview and features
- Installation instructions
- Upgrade procedures
- Docker instructions
- Supported equipment list
- Links to clients and integrations
- Changelog highlights
- License information

---

### `CONTRIBUTING.md`
**Purpose:** Contribution guidelines

**Topics:**
- How to report bugs
- Feature request process
- Code contribution workflow
- Coding standards
- Testing requirements

---

### `Changelog`
**Purpose:** Detailed version history

**Format:**
- Version number
- Release date
- New features
- Bug fixes
- Breaking changes
- Upgrade notes

---

### `LICENSE`
**Purpose:** Legal license document

**License:** GNU Affero General Public License v3.0 (AGPL-3.0)

**Key Points:**
- Free to use, modify, and distribute
- Must share source code of modifications
- Must use same license for derivative works
- Network use triggers license obligations

---

## Summary

The root directory contains:
- **1 Application Entry Point:** `app.ts`
- **1 Utility Script:** `sendSocket.js`
- **4 Configuration Files:** `package.json`, `tsconfig.json`, `defaultConfig.json`, `.eslintrc.json`
- **3 Container Files:** `Dockerfile`, `docker-compose.yml`, `Gruntfile.js`
- **3 Documentation Files:** `README.md`, `CONTRIBUTING.md`, `LICENSE`, `Changelog`
- **2 Git Files:** `.gitignore`, `.npmrc`

All files work together to provide a complete, containerized, and maintainable pool controller application.
