'use strict';
/**
 * End-to-end test: runs a real Homebridge process with this plugin against a
 * mock Trimlight cloud, then drives it through Homebridge's HAP HTTP API
 * (insecure mode) exactly like the Home app would.
 *
 * Usage: npm run test:e2e
 * Set HOMEBRIDGE_BIN to test a different Homebridge install (e.g. v2).
 */
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { createMockCloud } = require('./mockTrimlightCloud');

const ROOT = path.resolve(__dirname, '..', '..');
const HOMEBRIDGE_BIN = process.env.HOMEBRIDGE_BIN || path.join(ROOT, 'node_modules', 'homebridge', 'bin', 'homebridge');
const PIN = '031-45-154';
const CLIENT_ID = 'e2e-client';
const CLIENT_SECRET = 'e2e-secret';
const DEVICE_ID = 'e2e-device-0001';
const ON_TYPE = '00000025-0000-1000-8000-0026BB765291';
const LIGHTBULB_TYPE = '00000043-0000-1000-8000-0026BB765291';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** An every-day schedule window from `fromMin` to `toMin` minutes relative to now. */
function dailyWindow(fromMin, toMin) {
  const at = (offset) => {
    const d = new Date(Date.now() + offset * 60000);
    return { hours: d.getHours(), minutes: d.getMinutes() };
  };
  return { id: 0, enable: true, effectId: 1, repetition: 1, startTime: at(fromMin), endTime: at(toMin) };
}

function hap(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : undefined;
    const req = http.request({
      host: '127.0.0.1', port, method, path: urlPath,
      headers: { Authorization: PIN, 'Content-Type': 'application/hap+json', ...(data ? { 'Content-Length': data.length } : {}) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, body: text ? JSON.parse(text) : undefined });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

function normalizeType(type) {
  // HAP short form "25" -> full Apple base UUID.
  return /^[0-9A-F]{1,8}$/i.test(type) ? `${type.toUpperCase().padStart(8, '0')}-0000-1000-8000-0026BB765291` : type.toUpperCase();
}

async function waitFor(description, predicate, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await predicate();
    if (result) {
      return result;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for: ${description}`);
    }
    await sleep(250);
  }
}

function startHomebridge(storageDir, pluginDir) {
  const child = spawn(process.execPath, [HOMEBRIDGE_BIN, '-I', '-D', '-U', storageDir, '-P', pluginDir], {
    env: { ...process.env, FORCE_COLOR: '0', DEBUG: '' },
  });
  const proc = { child, output: '' };
  const append = (chunk) => {
    proc.output += chunk.toString();
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  return proc;
}

async function stopHomebridge(proc) {
  if (proc.child.exitCode !== null) {
    return;
  }
  const exited = new Promise((resolve) => proc.child.once('exit', resolve));
  proc.child.kill('SIGTERM');
  await Promise.race([exited, sleep(10000).then(() => proc.child.kill('SIGKILL'))]);
}

async function findOnCharacteristic(port) {
  const { body } = await hap(port, 'GET', '/accessories');
  for (const accessory of body.accessories) {
    for (const service of accessory.services) {
      if (normalizeType(service.type) !== LIGHTBULB_TYPE) {
        continue;
      }
      const on = service.characteristics.find((c) => normalizeType(c.type) === ON_TYPE);
      if (on) {
        return { aid: accessory.aid, iid: on.iid, accessories: body.accessories };
      }
    }
  }
  return undefined;
}

async function readOn(port, aid, iid) {
  const { body } = await hap(port, 'GET', `/characteristics?id=${aid}.${iid}`);
  const characteristic = body.characteristics[0];
  // HAP encodes booleans on the wire as 0/1.
  if (characteristic.value === 0 || characteristic.value === 1) {
    characteristic.value = characteristic.value === 1;
  }
  return characteristic;
}

async function main() {
  assert.ok(fs.existsSync(path.join(ROOT, 'dist', 'index.js')), 'Run "npm run build" first');

  const { server, state } = createMockCloud({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    devices: [{ deviceId: DEVICE_ID, name: 'Front House', switchState: 0, connectivity: 1, state: 0, fwVersionName: '1.2.3' }],
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const cloudUrl = `http://127.0.0.1:${server.address().port}/trimlight`;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trimlight-e2e-'));
  const storageDir = path.join(tmp, 'storage');
  const pluginDir = path.join(tmp, 'plugins');
  fs.mkdirSync(storageDir);
  fs.mkdirSync(pluginDir);
  fs.symlinkSync(ROOT, path.join(pluginDir, 'homebridge-trimlight-edge'));

  const hapPort = 50000 + Math.floor(Math.random() * 10000);
  fs.writeFileSync(path.join(storageDir, 'config.json'), JSON.stringify({
    bridge: { name: 'Trimlight E2E', username: '0E:11:22:33:44:55', port: hapPort, pin: PIN, advertiser: 'ciao', bind: ['127.0.0.1'] },
    accessories: [],
    platforms: [{
      platform: 'TrimlightEdge',
      name: 'Trimlight Edge',
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      pollingIntervalSeconds: 10,
      baseUrl: cloudUrl,
    }],
  }, null, 2));

  let hb = startHomebridge(storageDir, pluginDir);
  const step = (msg) => console.log(`  ✓ ${msg}`);
  try {
    await waitFor('accessory to be published', async () => {
      if (hb.child.exitCode !== null) {
        throw new Error(`Homebridge exited early:\n${hb.output}`);
      }
      return hb.output.includes('Adding Front House') && (await findOnCharacteristic(hapPort).catch(() => undefined));
    });
    const versionLine = (hb.output.match(/Homebridge v\d+\.\d+\.\d+[\w.-]*/) || ['Homebridge (unknown version)'])[0];
    console.log(`Running against ${versionLine} on Node ${process.version}`);
    step('plugin loaded and Lightbulb accessory published');

    const { aid, iid, accessories } = await findOnCharacteristic(hapPort);
    const info = accessories.find((a) => a.aid === aid).services
      .find((s) => normalizeType(s.type) === '0000003E-0000-1000-8000-0026BB765291').characteristics;
    const infoValue = (shortType) => info.find((c) => normalizeType(c.type) === normalizeType(shortType)).value;
    assert.strictEqual(infoValue('20'), 'Trimlight');
    assert.strictEqual(infoValue('30'), DEVICE_ID);
    assert.strictEqual(infoValue('52'), '1.2.3');
    step('accessory information (manufacturer, serial, firmware) is correct');

    assert.strictEqual((await readOn(hapPort, aid, iid)).value, false);
    step('initial state reads as off');

    let res = await hap(hapPort, 'PUT', '/characteristics', { characteristics: [{ aid, iid, value: true }] });
    assert.ok(res.status === 204 || res.status === 207, `unexpected status ${res.status}`);
    assert.strictEqual(state.devices[0].switchState, 1);
    assert.strictEqual((await readOn(hapPort, aid, iid)).value, true);
    step('turning on from HomeKit sets switchState=1 in the cloud');

    res = await hap(hapPort, 'PUT', '/characteristics', { characteristics: [{ aid, iid, value: false }] });
    assert.ok(res.status === 204 || res.status === 207, `unexpected status ${res.status}`);
    assert.strictEqual(state.devices[0].switchState, 0);
    assert.strictEqual((await readOn(hapPort, aid, iid)).value, false);
    step('turning off from HomeKit sets switchState=0 in the cloud');

    const updates = state.requests.filter((r) => r.path.endsWith('/device/update'));
    assert.deepStrictEqual(updates.map((r) => r.body), [
      { deviceId: DEVICE_ID, payload: { switchState: 1 } },
      { deviceId: DEVICE_ID, payload: { switchState: 0 } },
    ]);
    step('cloud received exactly the expected commands');

    // Changed outside HomeKit (e.g. from the Trimlight app). Wait past the
    // post-command cooldown plus one poll.
    state.devices[0].switchState = 1;
    await waitFor('external change to reach HomeKit', async () => (await readOn(hapPort, aid, iid)).value === true, 30000);
    step('turning on in the Trimlight app shows as on via polling');

    // Timer mode: lit only inside a schedule window. Windows are built around
    // the current time so the test doesn't depend on when it runs.
    state.devices[0].switchState = 2;
    state.devices[0].daily = [dailyWindow(120, 180)];
    await waitFor('timer mode outside its window to show off', async () => (await readOn(hapPort, aid, iid)).value === false, 30000);
    step('timer mode outside its schedule window shows as off');

    state.devices[0].daily = [dailyWindow(-60, 60)];
    await waitFor('timer mode inside its window to show on', async () => (await readOn(hapPort, aid, iid)).value === true, 30000);
    step('timer mode inside its schedule window shows as on');

    const commandsBefore = state.requests.filter((r) => r.path.endsWith('/device/update')).length;
    res = await hap(hapPort, 'PUT', '/characteristics', { characteristics: [{ aid, iid, value: true }] });
    assert.ok(res.status === 204 || res.status === 207, `unexpected status ${res.status}`);
    assert.strictEqual(state.requests.filter((r) => r.path.endsWith('/device/update')).length, commandsBefore);
    assert.strictEqual(state.devices[0].switchState, 2);
    step('"turn on" while the schedule has it lit leaves timer mode alone');

    state.devices[0].daily = [dailyWindow(120, 180)];
    await waitFor('timer mode back outside its window', async () => (await readOn(hapPort, aid, iid)).value === false, 30000);
    res = await hap(hapPort, 'PUT', '/characteristics', { characteristics: [{ aid, iid, value: true }] });
    assert.ok(res.status === 204 || res.status === 207, `unexpected status ${res.status}`);
    assert.strictEqual(state.devices[0].switchState, 1);
    assert.strictEqual((await readOn(hapPort, aid, iid)).value, true);
    step('"turn on" while the schedule has it dark switches to manual and lights up');

    // "Off for tonight": off outside a window goes straight back to timer mode.
    res = await hap(hapPort, 'PUT', '/characteristics', { characteristics: [{ aid, iid, value: false }] });
    assert.ok(res.status === 204 || res.status === 207, `unexpected status ${res.status}`);
    assert.strictEqual(state.devices[0].switchState, 2);
    assert.strictEqual((await readOn(hapPort, aid, iid)).value, false);
    step('"turn off" outside the schedule window returns to timer mode (schedule kept)');

    // Off during a window that ends at the next minute: off now, then timer
    // mode is restored by the plugin once the window is over.
    state.devices[0].daily = [dailyWindow(-60, 2)];
    await waitFor('timer window to show on', async () => (await readOn(hapPort, aid, iid)).value === true, 30000);
    res = await hap(hapPort, 'PUT', '/characteristics', { characteristics: [{ aid, iid, value: false }] });
    assert.ok(res.status === 204 || res.status === 207, `unexpected status ${res.status}`);
    assert.strictEqual(state.devices[0].switchState, 0);
    step('"turn off" during the schedule window turns the lights off now');
    await waitFor('timer mode to be restored after the window ends', async () => state.devices[0].switchState === 2, 180000);
    assert.strictEqual((await readOn(hapPort, aid, iid)).value, false);
    assert.ok(hb.output.includes('schedule window over, timer schedule restored'), 'restore was not logged');
    step('timer schedule is restored automatically once the window ends');

    state.devices[0].switchState = 1;
    await waitFor('manual mode to show on', async () => (await readOn(hapPort, aid, iid)).value === true, 30000);

    const detailReads = state.requests.filter((r) => r.path.endsWith('/device/get'));
    assert.ok(detailReads.length > 0 && detailReads.every((r) => r.body.deviceId === DEVICE_ID && r.body.currentDate), 'detail reads must carry deviceId and currentDate');
    step('state is read from the device detail endpoint');

    state.devices[0].connectivity = 0;
    await waitFor('offline controller to show No Response', async () => (await readOn(hapPort, aid, iid)).status === -70402, 20000);
    step('offline controller shows "No Response" in HomeKit');
    state.devices[0].connectivity = 1;
    await waitFor('controller to come back', async () => (await readOn(hapPort, aid, iid)).value === true, 20000);
    step('controller coming back online recovers');

    // Restart in the middle of "off for tonight": the pending schedule
    // restore must survive because Homebridge persisted the context to disk.
    // Show a dark window first so we know the plugin has seen timer mode
    // (it was in manual mode, which already reads as on).
    state.devices[0].switchState = 2;
    state.devices[0].daily = [dailyWindow(120, 180)];
    await waitFor('timer mode (dark) to be seen before restart', async () => (await readOn(hapPort, aid, iid)).value === false, 30000);
    state.devices[0].daily = [dailyWindow(-60, 2)];
    await waitFor('timer window to show on before restart', async () => (await readOn(hapPort, aid, iid)).value === true, 30000);
    res = await hap(hapPort, 'PUT', '/characteristics', { characteristics: [{ aid, iid, value: false }] });
    assert.ok(res.status === 204 || res.status === 207, `unexpected status ${res.status}`);
    assert.strictEqual(state.devices[0].switchState, 0);

    // Restart: the accessory must be restored from cache, not re-added.
    await stopHomebridge(hb);
    hb = startHomebridge(storageDir, pluginDir);
    await waitFor('accessory restored after restart', async () =>
      hb.output.includes('Restored Front House') && (await findOnCharacteristic(hapPort).catch(() => undefined)));
    assert.ok(!hb.output.includes('Adding Front House'), 'accessory was re-added instead of restored');
    const after = await findOnCharacteristic(hapPort);
    assert.strictEqual(after.aid, aid, 'accessory id changed across restart (Home app would lose it)');
    step('restart restores the cached accessory with the same identity');

    await waitFor('pending schedule restore to survive the restart', async () => state.devices[0].switchState === 2, 180000);
    assert.ok(hb.output.includes('schedule window over, timer schedule restored'), 'restore after restart was not logged');
    step('"off for tonight" survives a Homebridge restart and still restores the schedule');

    // Bad credentials are reported clearly.
    await stopHomebridge(hb);
    const config = JSON.parse(fs.readFileSync(path.join(storageDir, 'config.json'), 'utf8'));
    config.platforms[0].clientSecret = 'wrong';
    fs.writeFileSync(path.join(storageDir, 'config.json'), JSON.stringify(config));
    hb = startHomebridge(storageDir, pluginDir);
    await waitFor('credential error to be logged', async () => hb.output.includes('rejected the API credentials'));
    assert.ok(!hb.output.includes('Removing Front House'), 'auth failure must not remove accessories');
    step('wrong credentials produce a clear error and keep the accessory');

    const unexpected = hb.output.split('\n').filter((l) => /TypeError|ReferenceError|UnhandledPromiseRejection|characteristic warning|This plugin generated a warning/i.test(l));
    assert.deepStrictEqual(unexpected, [], 'Homebridge logged unexpected errors/warnings');
    step('no plugin warnings or unhandled errors in Homebridge logs');

    console.log('\nE2E PASSED');
  } catch (error) {
    console.error('\nE2E FAILED:', error.message);
    const cacheFile = path.join(storageDir, 'accessories', 'cachedAccessories');
    if (fs.existsSync(cacheFile)) {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      console.error('--- Cached accessory contexts ---\n' + JSON.stringify(cached.map((a) => {
        const { device, ...rest } = a.context || {};
        return { displayName: a.displayName, ...rest, switchState: device && device.switchState };
      }), null, 2));
    }
    console.error('--- Mock cloud state ---\n' + JSON.stringify(state.devices, null, 2));
    console.error('--- Homebridge output ---\n' + hb.output);
    process.exitCode = 1;
  } finally {
    await stopHomebridge(hb);
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main();
