# homebridge-trimlight-edge

Control your [Trimlight Edge](https://trimlight.com/) permanent lighting from the Apple Home app and Siri, via Homebridge or HOOBS.

Every Trimlight Edge controller on your account appears in Apple Home as a light you can turn **on and off**.

## Features

- Automatic discovery of all controllers on your Trimlight account
- On/off from Apple Home, Siri, scenes and automations
- Status stays in sync without constant polling. The plugin refreshes from the Trimlight cloud whenever the Home app (or a widget, or Siri) looks at the lights, follows your schedule windows on its own clock, and runs a light background check every 15 minutes
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

The plugin is published on npm as [`homebridge-trimlight-edge`](https://www.npmjs.com/package/homebridge-trimlight-edge).

- **HOOBS:** search for `homebridge-trimlight-edge` in the plugin search and install it. Putting it in its own bridge keeps it isolated from your other accessories. Over SSH, `sudo hbs plugin add homebridge-trimlight-edge` does the same. HOOBS only installs plugins from npm, not from local files.
- **Homebridge UI:** search for `homebridge-trimlight-edge` on the Plugins tab and install it.
- **Command line:** `sudo npm install -g homebridge-trimlight-edge`, then restart Homebridge.

To try unreleased changes from this repository on a regular Homebridge install, run `npm install && npm run build && npm pack`, then `sudo npm install -g ./homebridge-trimlight-edge-<version>.tgz`.

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
| `pollingIntervalSeconds` | No | `900` | Background check interval in seconds (minimum 60; `0` turns it off). Status is also refreshed whenever the Home app shows the accessory |

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
- The switch back to timer mode happens within about a minute after the window ends. The plugin re-checks the Trimlight cloud first, so it never overrides a change you made in the Trimlight app in the meantime. Lights stay off in between.
- Schedule windows are evaluated on the **controller's own clock**, which the plugin learns automatically, so it doesn't matter what time zone your Homebridge/HOOBS box runs in (HOOBS boxes typically run on UTC). Right after the first install this takes about a minute.

## Troubleshooting

- **"Trimlight rejected the API credentials"**: double-check `clientId`/`clientSecret`. These are API credentials (see [Getting your API credentials](#getting-your-api-credentials)), not your app login.
- **Accessory shows "No Response"**: the controller is offline according to the Trimlight cloud (check its Wi-Fi), or the last command failed. Details are in the HOOBS/Homebridge log.
- **HOOBS shows "0 plugins installed" / no settings form right after a release**: the HOOBS app takes plugin details from its own plugin directory, which picks up new npm releases with a delay, and HOOBS caches the answer. The plugin still runs. **Reboot the HOOBS box** to make it check again; restarting the bridge alone isn't enough. To enter your credentials meanwhile, run [`scripts/hoobs-set-credentials.js`](scripts/hoobs-set-credentials.js) on the HOOBS box (`node hoobs-set-credentials.js <bridge-id>`; bridge ids are listed in `/var/lib/hoobs/bridges.conf`). Log in with your HOOBS **username** from the Profiles page, not your email. Then restart the bridge.
- **Timer-mode lights show the wrong on/off state**: check the log for `following the controller's clock (UTC-07:00)` or similar, which should appear about a minute after the first install. The controller's clock is set by the Trimlight app; if the offset shown is wrong, open the Trimlight app so it can sync the controller's time.
- **Status takes a while to update after using the Trimlight app**: open the Home app. It shows the last known state immediately and updates within a few seconds. While Home is closed, changes made in the Trimlight app are picked up by the background check (every 15 minutes by default), so HomeKit automations triggered by the Trimlight's state react with that delay.

## Development

```bash
npm install
npm run lint       # ESLint
npm test           # unit tests (real local HTTP server + real HAP objects)
npm run test:e2e   # runs a real Homebridge instance against a mock Trimlight cloud
```

`npm run test:e2e` starts Homebridge in insecure mode with the plugin, points it at `test/e2e/mockTrimlightCloud.js` (which validates request signatures like the real API), and drives the accessory through the HAP HTTP API the same way the Home app does. Set `HOMEBRIDGE_BIN` to test another Homebridge install.

The Trimlight API reference is in [trimlight-edge-api-doc.md](trimlight-edge-api-doc.md).
