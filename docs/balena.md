# Deploying poolController (njsPC) via Balena

This guide describes how to push `nodejs-poolController` (njsPC) to a balena
fleet and run it on a Raspberry Pi gateway connected to a Pentair-compatible
RS-485 bus.

The configuration here is also the reference deployment for the AquaButler
customer fleet. Each customer Pi runs the same image; per-site overrides
(serial port, lat/long, MQTT broker) flow through **device variables** so a
single base image can be OTA-updated across every device.

---

## 1. Prerequisites

- A balenaCloud or self-hosted **open-balena** account (see
  `t_39ce177a` AQB-004 for the AquaButler open-balena fleet deployment).
- A balena application — recommended device type **`raspberrypi4-64`** (64-bit
  Pi 4 / Pi 400) or **`raspberrypizero2w-64`** (Pi Zero 2 W). 32-bit
  device-types (`raspberrypi3`, `raspberrypi4`) also work; the image
  includes the matching `serialport` prebuilt.
- A USB RS-485 adapter plugged into the Pi. The balena-supervisor maps it
  to `/dev/ttyUSB0` for FTDI / CH340 / CP2102 chipsets; some RS-485 shields
  enumerate as `/dev/ttyACM0`. Set the device variable `BALENA_RS485_DEVICE`
  if your hardware uses a different path.
- Pool equipment wired to the RS-485 bus per
  <https://github.com/tagyoureit/nodejs-poolController/wiki/RS-485-Adapter-Details>.

---

## 2. Image & build flow

`Dockerfile` is multi-arch: the existing GHCR workflow
(`.github/workflows/ghcr-publish.yml`) already builds and pushes
`linux/amd64,linux/arm64,linux/arm/v7` to `ghcr.io/ultron-aquabutler/njspc`.
`balena push <fleet>` will reuse those prebuilt images if the registry path
matches `balena.yml`'s `images.application` (`ghcr.io/ultron-aquabutler/njspc`)
and the SHA is referenced — otherwise balena falls back to a local
`docker build` using the same Dockerfile.

To force a fresh local build:

```bash
balena deploy <fleet> \
    --build \
    --source . \
    --logs
```

balenaOS reads `BALENA_RS485_DEVICE` (or the default `/dev/ttyUSB0`) and the
container's `POOL_RS485_PORT` env variable, which `Config.getEnvVariables()`
already patches into `controller.comms.rs485Port` (see `config/Config.ts`).

---

## 3. Service configuration

### Default environment (already set in `balena.yml`)

| Variable                  | Default                  | Purpose                                                |
| ------------------------- | ------------------------ | ------------------------------------------------------ |
| `POOL_RS485_PORT`         | `/dev/ttyUSB0`           | RS-485 device node. Patched into config at boot.       |
| `POOL_NET_CONNECT`        | `false`                  | Use direct serial, not a TCP/Socat bridge.             |
| `POOL_NET_HOST`           | `raspberrypi`            | TCP bridge target (only used if `POOL_NET_CONNECT=true`). |
| `POOL_NET_PORT`           | `9801`                   | TCP bridge port.                                       |
| `TZ`                      | `America/Phoenix`        | Site timezone for heliotrope / schedule calculations.  |
| `NODE_ENV`                | `production`             | Tells Logger.ts to suppress dev paths.                 |

### Per-device overrides (set in the balena dashboard → Device Variables)

| Variable                  | Example                                | Purpose                                |
| ------------------------- | -------------------------------------- | -------------------------------------- |
| `BALENA_RS485_DEVICE`     | `/dev/ttyACM0`                         | Override device-path bind in balenaOS. |
| `POOL_LATITUDE`           | `33.4484`                              | Skip early heliotrope warnings.        |
| `POOL_LONGITUDE`          | `-112.0740`                            | Same.                                  |
| `POOL_RS485_PORT`         | `/dev/ttyUSB1`                         | Override the in-container path.        |
| `POOL_WEB_SERVERS_HTTP_PORT` | `4200`                              | Change web port if 4200 conflicts.     |
| `LOG_LEVEL`               | `debug`                                | (When added — currently via config.json.) |

### Persistent storage

`balena.yml` declares named volumes that map onto the device's
balena-supervisor persistent storage:

- `poolcontroller-config`  → `/app/config.json`  (user-editable config)
- `poolcontroller-data`    → `/app/data`         (state & equipment snapshots)
- `poolcontroller-backups` → `/app/backups`      (auto-backup archives)
- `poolcontroller-logs`    → `/app/logs`         (winston logs)
- `poolcontroller-bindings`→ `/app/web/bindings/custom`

All survive OTA updates and device reboots. They are **not** shared across
devices — every customer Pi has its own copy. Do not bind these onto a
docker volume on the host.

---

## 4. RS-485 device binding

`balena.yml` exposes **two** device paths to the container because different
adapters enumerate differently:

```yaml
devices:
  - "/dev/ttyUSB0:/dev/ttyUSB0"
  - "/dev/ttyACM0:/dev/ttyACM0"
```

If your adapter uses a non-standard node (e.g. `/dev/ttyACM1`, `/dev/ttyUSB1`),
add another `devices:` entry or set the `BALENA_RS485_DEVICE` device variable
and update `POOL_RS485_PORT` to match.

To find which node the adapter enumerates as, SSH into the hostOS shell
(`balena ssh <device>`) and run `ls -la /dev/tty*`.

---

## 5. Healthcheck

balena-supervisor runs the service's healthcheck every 60 seconds:

```yaml
healthcheck:
  interval: 60s
  timeout: 8s
  start_period: 90s
  retries: 4
  path: /
  port: 4200
```

The Express server in `web/Server.ts` answers `GET /` with the dashboard
HTML. `start_period: 90s` accounts for the RS-485 retry timer (default
`controller.comms.inactivityRetry = 10s` × `~5` attempts) and the
TS-on-startup logging init. If you enable HTTPS with `httpsRedirect`,
balena's HTTP probe will fail; either disable the redirect or set
`path: /config` which always returns JSON regardless of HTTP/HTTPS.

---

## 6. OTA & restart behaviour

- `restart: always` is set so the supervisor restarts the container on
  crashes. The TypeScript app handles `SIGINT` cleanly via `stopAsync()`
  in `app.ts` — it persists config, closes the serial port, and exits 0.
- After an OTA update, balena stops the old container, replaces the image,
  and starts the new one. The `poolcontroller-config` named volume holds
  the existing `config.json`, so all settings persist across deploys.
- `controller.comms.rs485Port = "MOCK_PORT"` would disable the real
  adapter — keep `POOL_NET_CONNECT=false` and a real device path so the
  bus comes back online automatically.
- If the RS-485 adapter is unplugged at boot, `RS485Port.openAsync()`
  schedules a retry using `inactivityRetry * 1000ms`. The default is 10s.
  Re-plug the adapter and the container picks it up without a restart.

---

## 7. Smoke tests

After the device finishes provisioning:

```bash
# 1. Supervisor says the service is RUNNING and HEALTHY.
balena devices <fleet>
# Look at the service row — "running" with green healthcheck indicator.

# 2. Web UI loads.
curl -s -o /dev/null -w "%{http_code}\n" http://<device-ip>:4200/
# Expected: 200

# 3. REST API is alive.
curl -s http://<device-ip>:4200/config | jq '.controller.comms.rs485Port'
# Expected: "/dev/ttyUSB0" (or whatever you set POOL_RS485_PORT to)

# 4. Socket.IO endpoint.
curl -s "http://<device-ip>:4200/socket.io/?EIO=4&transport=polling" \
    | head -c 200
# Expected: 0{"sid":...,"upgrades":["websocket"],"pingInterval":...}

# 5. RS-485 bus reachable.
curl -s http://<device-ip>:4200/state | jq '.equipment.controllers'
# If the controller shows isActive:true, the bus is talking.
```

If `/state` shows no controllers, check
`/var/log/balena-supervisor/supervisor.log` on the device hostOS and the
njsPC container logs (`balena logs <device> poolController`).

---

## 8. Local / non-balena usage

The same image and `docker-compose.yml` work for desktop Linux (x86_64 or
arm64) using:

```bash
docker compose up -d
```

`POOL_RS485_PORT=/dev/ttyUSB0` should still be set. On macOS / Windows the
adapter typically enumerates as `/dev/cu.usbserial-*` or `COM3`; set
`POOL_NET_CONNECT=true` and run [socat] to bridge to a TCP socket if your
host can't expose raw USB.

---

## 9. Out of scope (separate cards)

- **MQTT broker configuration** — `defaultConfig.json` has the MQTT
  interface disabled. The AquaButler broker lives at the address set by
  `MQTT_HOST` / `MQTT_PORT` device variables (see `t_xxx` AQB-012).
- **relayEquipmentManager (REM) deployment** — separate balena service.
  See `t_yyy` AQB-013.
- **Customer portal integration** — telemetry is published to
  Supabase / Mosquitto, not into the njsPC web UI. See `t_zzz` AQB-007.