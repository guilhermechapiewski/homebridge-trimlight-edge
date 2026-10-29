#!/usr/bin/env node
'use strict';
/**
 * Smoke-test your Trimlight credentials against the real cloud using the
 * plugin's own API client, without involving Homebridge.
 *
 *   npm run build
 *   TRIMLIGHT_CLIENT_ID=... TRIMLIGHT_CLIENT_SECRET=... node scripts/trimlight-cli.js list
 *   TRIMLIGHT_CLIENT_ID=... TRIMLIGHT_CLIENT_SECRET=... node scripts/trimlight-cli.js on <deviceId>
 *   TRIMLIGHT_CLIENT_ID=... TRIMLIGHT_CLIENT_SECRET=... node scripts/trimlight-cli.js off <deviceId>
 *
 * Diagnostics (print the raw JSON the cloud returns):
 *   ... node scripts/trimlight-cli.js raw
 *   ... node scripts/trimlight-cli.js detail <deviceId>
 *
 * Watch what the cloud reports over time (e.g. while using the Trimlight
 * app), polling the way the plugin does (notify-update-shadow, then detail):
 *   ... node scripts/trimlight-cli.js watch <deviceId> [seconds, default 5]
 */
const { SwitchState, TrimlightClient } = require('../dist/trimlightApi');
const { isLit } = require('../dist/trimlightAccessory');

const SWITCH_NAMES = { 0: 'off', 1: 'manual', 2: 'timer' };
const COMMANDS = ['list', 'raw', 'on', 'off', 'detail', 'watch'];

const pad = (n) => String(n).padStart(2, '0');
const clock = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

/** The controller's own clock from the detail, as a local Date (or undefined). */
function deviceTime(detail) {
  const t = detail.currentDatetime;
  if (!t || typeof t.year !== 'number') {
    return undefined;
  }
  return new Date(2000 + t.year, t.month - 1, t.day, t.hours, t.minutes, t.seconds);
}

async function watch(client, deviceId, seconds, notifyErrors) {
  console.log(`Watching ${deviceId} every ${seconds}s (Ctrl-C to stop). Columns: time, switchState, plugin would show, controller clock (age), notify result`);
  let previous;
  for (;;) {
    const started = new Date();
    notifyErrors.length = 0;
    await client.notifyUpdateShadow(deviceId);
    const notify = notifyErrors.length ? `notify FAILED: ${notifyErrors.join('; ')}` : 'notify ok';
    try {
      const detail = await client.getDeviceDetail(deviceId);
      const now = new Date();
      const lit = isLit({ deviceId, ...detail }, now) ? 'ON ' : 'off';
      const device = deviceTime(detail);
      const age = device ? `${Math.round((now - device) / 1000)}s` : '?';
      const state = `${detail.switchState} (${SWITCH_NAMES[detail.switchState] ?? '?'})`;
      const changed = previous !== undefined && previous !== detail.switchState ? '  <-- changed' : '';
      previous = detail.switchState;
      console.log(`${clock(now)}  switchState=${state.padEnd(10)}  Home=${lit}  controller clock ${device ? clock(device) : '?'} (age ${age})  ${notify}${changed}`);
    } catch (error) {
      console.log(`${clock(new Date())}  detail FAILED: ${error.message}  ${notify}`);
    }
    const wait = seconds * 1000 - (Date.now() - started.getTime());
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

async function main() {
  const [command, deviceId] = process.argv.slice(2);
  const clientId = process.env.TRIMLIGHT_CLIENT_ID;
  const clientSecret = process.env.TRIMLIGHT_CLIENT_SECRET;
  if (!clientId || !clientSecret || !COMMANDS.includes(command) || (!['list', 'raw'].includes(command) && !deviceId)) {
    console.error('Usage: TRIMLIGHT_CLIENT_ID=... TRIMLIGHT_CLIENT_SECRET=... node scripts/trimlight-cli.js list | raw | on <deviceId> | off <deviceId> | detail <deviceId> | watch <deviceId> [seconds]');
    process.exit(2);
  }

  const notifyErrors = [];
  const client = new TrimlightClient({
    clientId,
    clientSecret,
    // For testing against test/e2e/mockTrimlightCloud.js.
    baseUrl: process.env.TRIMLIGHT_BASE_URL || undefined,
    debug: (m) => {
      if (command === 'watch' && m.startsWith('notify-update-shadow failed')) {
        notifyErrors.push(m.replace(/^notify-update-shadow failed for \S+: /, ''));
      } else {
        console.error(`[debug] ${m}`);
      }
    },
  });
  if (command === 'watch') {
    const seconds = Math.max(2, Number(process.argv[4]) || 5);
    await watch(client, deviceId, seconds, notifyErrors);
    return;
  }
  if (command === 'raw') {
    console.log(JSON.stringify(await client.listDevices(), null, 2));
    return;
  }
  if (command === 'detail') {
    console.log(JSON.stringify(await client.getDeviceDetail(deviceId), null, 2));
    return;
  }
  if (command === 'list') {
    const devices = await client.listDevices();
    if (!devices.length) {
      console.log('No devices on this account.');
    }
    for (const d of devices) {
      // The list has no switch state; it only comes with the device detail.
      let status = 'status unknown (offline)';
      if (d.connectivity === 1) {
        const detail = await client.getDeviceDetail(d.deviceId);
        const lit = isLit({ ...d, ...detail }, new Date()) ? 'lit' : 'dark';
        status = `${SWITCH_NAMES[detail.switchState] ?? detail.switchState} -> ${lit} now`;
      }
      console.log(`${d.deviceId}  "${d.name}"  ${status}  ${d.connectivity === 1 ? 'online' : 'OFFLINE'}  fw ${d.fwVersionName ?? '?'}`);
    }
    return;
  }
  await client.setSwitchState(deviceId, command === 'on' ? SwitchState.Manual : SwitchState.Off);
  console.log(`Turned ${command} ${deviceId}`);
}

main().catch((error) => {
  console.error(`Failed: ${error.message}`);
  process.exit(1);
});
