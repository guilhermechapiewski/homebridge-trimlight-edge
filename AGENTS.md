# AGENTS.md

Guidance for AI coding agents (and humans) working on this repo. `CLAUDE.md` imports this file. Keep it current: update "Status" when work lands, and add any new real-API quirk you discover.

## What this is

A Homebridge plugin (`homebridge-trimlight-edge`) that exposes Trimlight Edge permanent-lighting controllers to Apple Home through the Trimlight V2 **cloud** API. It runs on the owner's **HOOBS** box. Scope so far is on/off only. Richer controls (brightness, color, effects) are planned for later.

## Working agreements

- **Quality bar:** senior-level, robust code with tests. Verify everything (lint, unit tests, e2e, plus a real-API check when the change touches API behavior) **before** asking the owner to look. Report what could not be verified.
- **Commits:** commit verified, green states **directly to `main`** after each chunk of work, with messages explaining what changed and why. No feature branches for now.
- **Ask first** before anything outward-facing: `git push`, `npm publish`, or anything else that leaves this machine.
- **Never commit secrets.** Trimlight `clientId`/`clientSecret` are only passed via the `TRIMLIGHT_CLIENT_ID` / `TRIMLIGHT_CLIENT_SECRET` env vars, never written to files.
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

`test:e2e` uses `HOMEBRIDGE_BIN` to target another Homebridge install. Before releasing, run it across the version matrix: Homebridge 1.3.4 and 1.5.0 on Node 16, and Homebridge 2.4.x on Node 22. Install those into a scratch directory with `npm install node@<v> homebridge@<v>` and run that node binary on `test/e2e/run-e2e.js`. Node 14 has no Apple Silicon build, so check ES2020 syntax with `npx acorn --ecma2020 dist/*.js` instead.

## Compatibility constraints (HOOBS)

HOOBS boxes run old runtimes, seen in the wild as Node 14–16 with Homebridge 1.3–1.5.

- `engines`: Node `>=14.18.0`, Homebridge `^1.3.0 || ^2.0.0`. Verify any new HAP or Homebridge API against 1.3.
- **No runtime dependencies.** Use Node's `http`/`https`, not `fetch`. Node 14 has no `fetch`, and `fetch` refuses GET bodies, which this API needs.
- The compile target is ES2020 / CommonJS. Don't use newer syntax or runtime APIs (`Array.prototype.at`, `structuredClone`, etc.).

## Code map

- `src/trimlightApi.ts`: cloud client. Handles HMAC signing, serialized and spaced requests (300 ms), retries with backoff for 5xx/429/network/20000, and typed errors (`TrimlightApiError`, `TrimlightAuthError`).
- `src/schedule.ts`: decides whether timer mode is lit right now, from the daily/calendar schedules. Ported from the MIT-licensed [trimlight-edge-ha](https://github.com/Michael-Civitillo/trimlight-edge-ha).
- `src/trimlightAccessory.ts`: the HomeKit Lightbulb (or Switch) for each controller, `isLit()`, and the "off for tonight" state machine.
- `src/platform.ts`: config parsing, polling (list → notify-update-shadow → detail per online device), and accessory add/restore/remove.
- `test/e2e/`: mock cloud (mirrors real responses) and the end-to-end runner (drives Homebridge's insecure HAP HTTP API).
- `trimlight-edge-api-doc.md`: the official API doc (converted from PDF). It has gaps and errors; see the quirks below.

## Real Trimlight API behavior (verified; differs from the doc)

- **The device list has no `switchState`.** On/off only comes from `POST /v1/oauth/resources/device/get` (detail). The list's `fwVersionName` (e.g. `1.17.4173`) differs from the detail's (`1.17.77`); the plugin uses the list's.
- **Detail can be stale by days** until the controller reports in. Call `GET .../device/notify-update-shadow` first; `currentDatetime` in the detail shows how fresh it is. Detail reflected a `device/update` immediately in testing.
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

## Deployment notes

- Install route: **publish to npm**, then install from the HOOBS plugin search, or over SSH with `sudo hbs plugin add homebridge-trimlight-edge`. The plan is to put it in a separate HOOBS bridge for isolation.
- Local-file installs don't work through HOOBS. Per the hoobsd source, `hbs plugin add` runs `yarn add <name>@<tag>` in `/var/lib/hoobs/<bridge>`. HOOBS loads only plugins listed in that folder's `package.json` dependencies that carry the `homebridge-plugin` keyword, and never loads global installs.
- Credentials come from Trimlight: https://trimlight.com/support/does-the-edge-have-an-open-api

## Status (update as work lands)

- Done: on/off with schedule awareness and "off for tonight"; tests and e2e green on Homebridge 1.3.4, 1.5.0, 1.11.4 and 2.4.0. The real cloud has been checked with the owner's credentials (list/detail/on/off).
- Next: deploy. Owner runs `npm login`, then publish v0.1.0 (with the owner's OK; the npm name was free as of 2026-10-28), then install on HOOBS and run the on-phone checklist in the README/plan.
- Later: brightness, color, effects. Use trimlight-edge-ha as the reference for the effect API pitfalls.
