# AGENTS.md

Guidance for AI coding agents (and humans) working on this repo. `CLAUDE.md` imports this file. Keep it current: update "Status" when work lands, and add any new real-API quirk you discover.

## What this is

A Homebridge plugin (`homebridge-trimlight-edge`) that exposes Trimlight Edge permanent-lighting controllers to Apple Home through the Trimlight V2 **cloud** API. It runs on the owner's **HOOBS** box. Scope so far is on/off only. Richer controls (brightness, color, effects) are planned for later.

## Working agreements

- **Quality bar:** senior-level, robust code with tests. Verify everything (lint, unit tests, e2e, plus a real-API check when the change touches API behavior) **before** asking the owner to look. Report what could not be verified.
- **Commits:** commit verified, green states **directly to `main`** after each chunk of work, with messages explaining what changed and why. No feature branches for now.
- **Ask first** before anything outward-facing: `git push`, `npm publish`, or anything else that leaves this machine.
- **Never commit secrets.** Trimlight `clientId`/`clientSecret` are only passed via the `TRIMLIGHT_CLIENT_ID` / `TRIMLIGHT_CLIENT_SECRET` env vars, never written to files.
- **Licensing:** the project is ISC (`LICENSE`). `src/schedule.ts` is ported from MIT-licensed code, whose notice lives in `NOTICE` and must ship in the package. Add to `NOTICE` whenever more code is ported.
- Match the surrounding code style (TypeScript, single quotes, semicolons, trailing commas; see `eslint.config.mjs`).

## Commands

```bash
npm run lint        # ESLint, zero warnings allowed (src, test, scripts)
npm run typecheck
npm test            # Jest unit tests: real local HTTP server + real HAP objects from homebridge
npm run test:e2e    # builds, then runs real Homebridge against test/e2e/mockTrimlightCloud.js (~6 min; real-time schedule windows)
npm run build       # tsc -> dist/ (CommonJS, ES2020)

# Real cloud smoke test (owner's credentials via env vars; needs a build)
node scripts/trimlight-cli.js list | raw | detail <id> | on <id> | off <id>
```

Before publishing, also run the e2e against the packed artifact: `npm pack`, extract it, then set `E2E_PLUGIN_PATH=<extracted>/package` for `node test/e2e/run-e2e.js`. This catches files missing from `package.json` `files`. `test:e2e` uses `HOMEBRIDGE_BIN` to target another Homebridge install. Before releasing, run it across the version matrix: Homebridge 1.3.4 and 1.5.0 on Node 16, and Homebridge 2.4.x on Node 22. Install those into a scratch directory with `npm install node@<v> homebridge@<v>` and run that node binary on `test/e2e/run-e2e.js`. Node 14 has no Apple Silicon build, so check ES2020 syntax with `npx acorn --ecma2020 dist/*.js` instead.

## Compatibility constraints (HOOBS)

HOOBS boxes run old runtimes, seen in the wild as Node 14–16 with Homebridge 1.3–1.5.

- `engines`: Node `>=14.18.0`, Homebridge `^1.3.0 || ^2.0.0`. Verify any new HAP or Homebridge API against 1.3.
- **No runtime dependencies.** Use Node's `http`/`https`, not `fetch`. Node 14 has no `fetch`, and `fetch` refuses GET bodies, which this API needs.
- The compile target is ES2020 / CommonJS. Don't use newer syntax or runtime APIs (`Array.prototype.at`, `structuredClone`, etc.).

## Code map

- `src/trimlightApi.ts`: cloud client. Handles HMAC signing, serialized and spaced requests (300 ms), retries with backoff for 5xx/429/network/20000, and typed errors (`TrimlightApiError`, `TrimlightAuthError`).
- `src/schedule.ts`: decides whether timer mode is lit right now, from the daily/calendar schedules. Ported from the MIT-licensed [trimlight-edge-ha](https://github.com/Michael-Civitillo/trimlight-edge-ha).
- `src/trimlightAccessory.ts`: the HomeKit Lightbulb (or Switch) for each controller, `isLit()`, and the "off for tonight" state machine.
- `src/platform.ts`: config parsing, the refresh model (see below), and accessory add/restore/remove.
- `test/e2e/`: mock cloud (mirrors real responses) and the end-to-end runner (drives Homebridge's insecure HAP HTTP API).
- `trimlight-edge-api-doc.md`: the official API doc (converted from PDF). It has gaps and errors; see the quirks below.

## Real Trimlight API behavior (verified; differs from the doc)

- **The device list has no `switchState`.** On/off only comes from `POST /v1/oauth/resources/device/get` (detail). The list's `fwVersionName` (e.g. `1.17.4173`) differs from the detail's (`1.17.77`); the plugin uses the list's.
- **Detail can be stale by days** until the controller reports in. Call `GET .../device/notify-update-shadow` first, then **wait ~2 s** before reading the detail. Reading immediately can return the state from before a change made in the Trimlight app; the owner saw Home show the wrong state with 0.1.0. `currentDatetime` in the detail shows how fresh it is. Detail reflected a `device/update` immediately in testing. `node scripts/trimlight-cli.js watch <id>` shows this live.
- **Bad credentials return HTTP 207** with an OAuth body (`{"error":"invalid_token","error_description":"The access token expired"}`), not the documented code `10001`. A missing token returns HTTP 401. "Token expired" can also mean the host clock is wrong.
- **GET endpoints take a JSON body** (e.g. `{"page":0}` for the device list).
- **Error 20000** means requests came too fast or concurrently, so keep them serialized. Per trimlight-edge-ha: **12006** means the cloud can't parse the stored effects (duplicate or oddly named effects), and when saving effects, `category` must be `0` (built-in) or `1` (custom), whatever the doc's examples show.
- `switchState`: 0 = off, 1 = manual, 2 = timer. In timer mode it stays 2 even while the schedule has the lights dark.

## On/off behavior (owner-approved design)

- **Shows on:** manual mode, or timer mode inside a schedule window. If the schedule can't be determined, timer mode counts as lit. An unknown state counts as off.
- **"Turn on":** a no-op if already lit, so a running schedule isn't knocked into manual mode. Otherwise it sets manual.
- **"Off for tonight":** if the controller follows a schedule (it was seen in timer mode; persisted in `accessory.context.followsSchedule`):
  - Off during a window sends 0, and the plugin restores timer mode (2) on the first poll after the window ends.
  - Off outside a window goes straight to 2.
  - An off or manual state that the plugin didn't command (`context.commandedState`) means the user changed it in the Trimlight app, so the schedule memory is dropped.
- Polled state is ignored for 10 s after a command, so a stale poll can't flip the tile back.

## Time zones (0.2.1)

The owner's HOOBS box runs on **UTC** (`/etc/timezone` = `Etc/UTC`) while the house and controller are on Pacific time, so 0.2.0 showed timer-mode lights off during their window. The owner does **not** want the box's time zone changed; the plugin must work in any host zone.
- Schedules are evaluated on the **controller clock offset learned from `detail.currentDatetime`** (persisted in `context.clockOffsetMinutes`). That's the clock the controller runs its schedule on, so following it is correct by definition. Before it's learned, host local time is used, and a UTC host logs a one-time info line.
- **No time zone setting in the UI** (owner decision: "it should just work"). A `timezone` key in config.json still works as an undocumented override, for controllers that never report their clock. Don't add it to the form or README.
- The offset is trusted only after two readings ≥60 s apart that tick in step with real time (stale detail can be days old) and sit within 2 min of a 15-min offset no more than 14 h from UTC. The accessory requests its own confirming read about 65 s after the first one.
- `currentDate` sent to Trimlight uses the same zone. The Home Assistant integration says it "drives the device clock"; the owner's lights kept their schedule while 0.2.0 sent UTC, so it's probably ignored, but don't send wrong times.
- `src/timeZone.ts` handles conversion with `Intl` (no dependencies). Tests pass with the host in UTC, Tokyo, Kiritimati, St. John's, London and LA (`TZ=... npx jest`). The e2e takes `E2E_HOMEBRIDGE_TZ=UTC` to run Homebridge in a different zone from the mock controller.

## Refresh model (owner-approved; 0.2.0)

The owner asked to avoid constant polling (0.1.0 made about 8,600 calls a day at 30 s).
- **On HomeKit read** (the Home app, widgets, Siri, HomePod): `onGet` answers instantly from cached state and triggers a background refresh (notify, wait 2 s, then detail). Refreshes are throttled to one per device per 15 s and coalesced; a change is pushed with `updateCharacteristic`.
- **Local clock tick every 60 s** (no API calls): re-evaluates timer schedules so Home flips at window boundaries. When an "off for tonight" restore is due, it **forces a fresh read first**, so it never overrides a Trimlight-app change made while Home was closed.
- **Background check** (device list plus status) at startup and every `pollingIntervalSeconds` (default 900; min 60; 0 = off). Failed checks retry after 30 s, doubling.
- Trade-off: HomeKit automations triggered by Trimlight state see Trimlight-app changes only on the next background check.

## Deployment notes

- Install route: **publish to npm**, then install from the HOOBS plugin search, or over SSH with `sudo hbs plugin add homebridge-trimlight-edge`. The plan is to put it in a separate HOOBS bridge for isolation.
- Local-file installs don't work through HOOBS. Per the hoobsd source, `hbs plugin add` runs `yarn add <name>@<tag>` in `/var/lib/hoobs/<bridge>`. HOOBS loads only plugins listed in that folder's `package.json` dependencies that carry the `homebridge-plugin` keyword, and never loads global installs.
- **The HOOBS UI depends on the HOOBS plugin directory** (`plugins.hoobs.org`), which mirrors npm on its own schedule. Until a newly published package is indexed (`https://plugins.hoobs.org/api/plugins?identifier=homebridge-trimlight-edge` returns `count: 0`), HOOBS still installs and runs the plugin, but the bridge page shows "0 plugins installed" with no settings form. No HOOBS command to speed up indexing is known. Observed timing: first publish 2026-10-29 01:45 UTC, indexed by about 04:00 UTC. Later versions show up within minutes (0.2.1 was listed about 20 min after publish).
- **The directory can drop a plugin it had indexed.** On 2026-10-31 the identifier lookup returned `count: 0` for us again, after it had listed 0.2.1 and the settings form had worked. Its responses now carry `"deprecated": true`, and `homebridge-zengge-ledenet` (published 2026-08) is missing too. The `hoobs-plugin` keyword was added in 0.2.2 as a cheap try, but it's probably not what drives indexing: only ~42 npm packages use it, and plugins like `homebridge-hue` and `homebridge-ring` are listed with just `homebridge-plugin`.
- **HOOBS desktop plugin page crashes for brand-new plugins** (blank page after a second; the mobile/narrow layout works). Diagnosed 2026-10-29 from the box's own `main.js`: the "Average Weekly Downloads" graph does `n.slice(0,7).reduce((a,b)=>a+b)` for 52 weeks over `downloads` from `https://plugins.hoobs.org/api/<name>`, and throws "Reduce of empty array with no initial value" when the history has fewer than ~360 days (ours had 0; npm's download stats didn't know the package yet). This is a HOOBS bug, not ours; nothing in the package can avoid it. Expected to resolve once npm stats exist and the directory refreshes, since npm's last-year range is zero-padded to 365 days. Check with `curl -s https://plugins.hoobs.org/api/homebridge-trimlight-edge | jq '.downloads | length'` (needs ≥ ~360).
- **HOOBS caches the directory's answer.** Even after indexing, the settings form only appeared after the owner **rebooted the HOOBS box**, which made it re-query. Tell users to reboot HOOBS if a freshly published plugin still shows "0 plugins installed". Restarting just the bridge wasn't enough.
- **HOOBS bridge configs are encrypted** (`/var/lib/hoobs/<bridge-id>.conf`, AES), so they can't be edited by hand, and the box has no text editor. The workaround is `scripts/hoobs-set-credentials.js`: run on the box with `node hoobs-set-credentials.js <bridge-id>`. It logs in to the HOOBS hub API (`POST /api/auth/logon`, then `GET`/`POST /api/config/<bridge>` with the raw token in `Authorization`) and sets `clientId`/`clientSecret` on the `TrimlightEdge` entry. The login is the HOOBS **local** username (from the app's Profiles page), not the HOOBS account email. This worked on the owner's box on 2026-10-29. The owner's bridge id is `trimlight`; logs are in `/var/lib/hoobs/hoobs.log`.
- Credentials come from Trimlight: https://trimlight.com/support/does-the-edge-have-an-open-api

## Status (update as work lands)

- Done: on/off with schedule awareness and "off for tonight"; tests and e2e green on Homebridge 1.3.4, 1.5.0, 1.11.4 and 2.4.0. The real cloud has been checked with the owner's credentials (list/detail/on/off). 0.1.0 is installed and working on the owner's HOOBS (on/off from Apple Home confirmed 2026-10-29).
- 0.2.0 (refresh model) was published and installed on the owner's HOOBS. It showed timer-mode lights off during their window because the box is on UTC.
- 0.2.1 (controller-clock time zones) published 2026-10-29; the npm shasum matches the tested tarball. The HOOBS settings form now works on the owner's box (after a reboot).
- 0.2.2 (metadata only: adds the `hoobs-plugin` keyword) committed; lint, unit tests and e2e against the packed tarball pass. Version matrix not rerun, since no code changed. Awaiting `npm publish` by the owner.
- Published: `homebridge-trimlight-edge@0.1.0` on npm (2026-10-29). The owner publishes from their own terminal (`npm publish`), approving with npm 2FA (security key / Touch ID); agents can't complete that step. npm's staged publishing shows a `0.0.0-stage` placeholder for a few minutes before the real version appears.
- Next: install on HOOBS in a separate bridge and run the on-phone checklist (on/off, Siri, Trimlight-app change, offline, restart, and "off for tonight" during a real 18:00-21:00 window).
- Releasing a new version: bump `version` in package.json, verify (lint, test, e2e including against the packed tarball), commit, then the owner runs `npm publish` and pushes.
- Later: brightness, color, effects. Use trimlight-edge-ha as the reference for the effect API pitfalls.
