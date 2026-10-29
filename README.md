# homebridge-trimlight-edge

Control your [Trimlight Edge](https://trimlight.com/) permanent lighting from the Apple Home app and Siri, via Homebridge or HOOBS.

Every Trimlight Edge controller on your account appears in Apple Home as a light you can turn **on and off**.

## Features

- Automatic discovery of all controllers on your Trimlight account
- On/off from Apple Home, Siri, scenes and automations
- Status stays in sync when lights are changed from the Trimlight app or by a schedule (polled every 30 s by default)
- Controllers that are offline show as **No Response** instead of a wrong state
- Understands Trimlight timer schedules: shows on only while a schedule window is active, "turn on" never interrupts a running schedule, and "turn off" only lasts until the current window ends (your schedule keeps running the next day)
- No runtime dependencies; works on the older Node.js/Homebridge versions found on HOOBS boxes

## Requirements

- Homebridge **1.3.0 or newer** (including 2.x), or HOOBS 4
- Node.js **14.18 or newer**
- **Trimlight API credentials** (a `clientId` and `clientSecret`). These are not the same as your Trimlight app login. See [Getting your API credentials](#getting-your-api-credentials).

## Getting your API credentials

1. Go to Trimlight's [Does the Edge have an open API?](https://trimlight.com/support/does-the-edge-have-an-open-api) support page.
2. Follow its link to apply for API credentials.
3. Once approved, Trimlight provides a `clientId` and `clientSecret`. Keep them private; anyone with them can control your lights.

## Installation

### From npm (once published)

Search for `homebridge-trimlight-edge` in the HOOBS or Homebridge UI plugin search and install it.

### From this repository (before publishing)

```bash
npm install
npm run build
npm pack            # creates homebridge-trimlight-edge-<version>.tgz
```

- **Homebridge (global npm install):** `sudo npm install -g ./homebridge-trimlight-edge-<version>.tgz`, then restart Homebridge.
- **HOOBS:** HOOBS manages plugins itself and does not load globally installed ones. Copy the `.tgz` to the device and try `sudo hbs plugin add /path/to/homebridge-trimlight-edge-<version>.tgz`. Local-file installs are not well documented by HOOBS, so publishing to npm and installing from the HOOBS plugin search is the most reliable route.

## Configuration

Fill in the settings form in the HOOBS/Homebridge UI, or add this to the `platforms` section of `config.json`:

```json
{
  "platform": "TrimlightEdge",
  "name": "Trimlight Edge",
  "clientId": "YOUR_CLIENT_ID",
  "clientSecret": "YOUR_CLIENT_SECRET"
}
```

| Field | Required | Default | Description |
| :--- | :--- | :--- | :--- |
| `platform` | Yes | | Must be `TrimlightEdge` |
| `clientId` | Yes | | Trimlight API Client ID |
| `clientSecret` | Yes | | Trimlight API Client Secret |
| `exposeAs` | No | `lightbulb` | `lightbulb` (included in "turn off all the lights") or `switch` |
| `pollingIntervalSeconds` | No | `30` | How often to refresh status from the Trimlight cloud (minimum 10) |

After restarting you should see something like:

```
[Trimlight Edge] Adding Front House (xxxxxxxxxxxx)
```

## How on/off maps to Trimlight

Trimlight controllers have three switch states: **off**, **manual** and **timer** (running your daily/calendar schedules).

| Apple Home | Trimlight |
| :--- | :--- |
| Shows **on** | Manual mode, or timer mode **while a schedule window is active** |
| Shows **off** | Off, or timer mode **outside** its schedule windows |
| Turn **on** while it's already lit | Nothing is sent, so a running schedule is left alone |
| Turn **on** while it's dark | Switches to **manual**, which resumes the last effect |
| Turn **off** during a schedule window | Turns **off now**; the plugin switches back to **timer** mode once the window ends, so the next scheduled window (e.g. tomorrow evening) runs as usual |
| Turn **off** at any other time | If the controller normally runs on a schedule, switches straight back to **timer** mode (dark outside its windows); otherwise switches to **off** |

Things to know:

- The plugin treats a controller as "running on a schedule" once it has seen it in timer mode. This survives Homebridge/HOOBS restarts.
- If you switch the controller to off or manual **in the Trimlight app**, the plugin treats that as your choice and stops restoring the schedule until it sees timer mode again.
- The switch back to timer mode happens on the first status refresh after the window ends (within `pollingIntervalSeconds`). Lights stay off in between.
- Schedule windows are evaluated using the Homebridge/HOOBS device's clock and time zone, so make sure it matches your house.

## Troubleshooting

- **"Trimlight rejected the API credentials"**: double-check `clientId`/`clientSecret`. These are API credentials (see [Getting your API credentials](#getting-your-api-credentials)), not your app login.
- **Accessory shows "No Response"**: the controller is offline according to the Trimlight cloud (check its Wi-Fi), or the last command failed. Details are in the HOOBS/Homebridge log.
- **Status takes a while to update after using the Trimlight app**: changes made outside Apple Home are picked up on the next refresh (`pollingIntervalSeconds`).

## Development

```bash
npm install
npm run lint       # ESLint
npm test           # unit tests (real local HTTP server + real HAP objects)
npm run test:e2e   # runs a real Homebridge instance against a mock Trimlight cloud
```

`npm run test:e2e` starts Homebridge in insecure mode with the plugin, points it at `test/e2e/mockTrimlightCloud.js` (which validates request signatures like the real API), and drives the accessory through the HAP HTTP API the same way the Home app does. Set `HOMEBRIDGE_BIN` to test another Homebridge install.

The Trimlight API reference is in [trimlight-edge-api-doc.md](trimlight-edge-api-doc.md).
