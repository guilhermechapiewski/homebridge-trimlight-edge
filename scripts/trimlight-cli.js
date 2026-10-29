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
 */
const { SwitchState, TrimlightClient } = require('../dist/trimlightApi');

const SWITCH_NAMES = { 0: 'off', 1: 'manual (on)', 2: 'timer' };

async function main() {
  const [command, deviceId] = process.argv.slice(2);
  const clientId = process.env.TRIMLIGHT_CLIENT_ID;
  const clientSecret = process.env.TRIMLIGHT_CLIENT_SECRET;
  if (!clientId || !clientSecret || !['list', 'raw', 'on', 'off', 'detail'].includes(command) || (!['list', 'raw'].includes(command) && !deviceId)) {
    console.error('Usage: TRIMLIGHT_CLIENT_ID=... TRIMLIGHT_CLIENT_SECRET=... node scripts/trimlight-cli.js list | raw | on <deviceId> | off <deviceId> | detail <deviceId>');
    process.exit(2);
  }

  const client = new TrimlightClient({ clientId, clientSecret, debug: (m) => console.error(`[debug] ${m}`) });
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
      console.log(`${d.deviceId}  "${d.name}"  ${SWITCH_NAMES[d.switchState] ?? d.switchState}  ${d.connectivity === 1 ? 'online' : 'OFFLINE'}  fw ${d.fwVersionName ?? '?'}`);
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
