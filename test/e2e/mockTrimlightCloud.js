'use strict';
/**
 * A small stand-in for the Trimlight cloud API used by the end-to-end test
 * (and handy for manual testing). It validates request signatures exactly as
 * the real API documents them and keeps device state in memory.
 *
 * Run standalone: node test/e2e/mockTrimlightCloud.js [port]
 */
const crypto = require('crypto');
const http = require('http');

function createMockCloud({ clientId, clientSecret, devices }) {
  const state = {
    devices: devices.map((d) => ({ ...d })),
    requests: [],
  };

  const reply = (res, status, body) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(body));
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let body = {};
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        return reply(res, 400, { code: 10001, desc: 'bad json' });
      }
      const path = (req.url || '').split('?')[0];
      state.requests.push({ method: req.method, path, body });

      const ts = req.headers['s-timestamp'];
      const expected = crypto.createHmac('sha256', clientSecret).update(`Trimlight|${clientId}|${ts}`).digest('base64');
      if (!req.headers.authorization) {
        return reply(res, 401, { error: 'invalid_token', error_description: 'The request header does not contain an access token' });
      }
      if (req.headers['s-clientid'] !== clientId || req.headers.authorization !== expected) {
        // What the real gateway returns for bad credentials (observed).
        return reply(res, 207, { error: 'invalid_token', error_description: 'The access token expired' });
      }

      const find = () => state.devices.find((d) => d.deviceId === body.deviceId);
      if (req.method === 'GET' && path === '/trimlight/v1/oauth/resources/devices') {
        // Like the real cloud: the list carries no switch state or schedules.
        const data = state.devices.map((d) => ({
          deviceId: d.deviceId, name: d.name, connectivity: d.connectivity, state: d.state, fwVersionName: d.fwVersionName,
        }));
        return reply(res, 200, { code: 0, desc: 'success', payload: { total: data.length, current: 0, data } });
      }
      if (req.method === 'POST' && path === '/trimlight/v1/oauth/resources/device/get') {
        const device = find();
        if (!device) {
          return reply(res, 200, { code: 10001, desc: 'no device' });
        }
        return reply(res, 200, {
          code: 0,
          desc: 'success',
          payload: {
            name: device.name, switchState: device.switchState, connectivity: device.connectivity, state: device.state,
            colorOrder: 0, ic: 0, fwVersionName: '1.17.77', effects: [], combinedEffect: { effectIds: [], interval: 5 },
            daily: device.daily || [], calendar: device.calendar || [], currentEffect: {}, overlayEffects: [],
            currentDatetime: (() => {
              const d = new Date();
              return { year: d.getFullYear() - 2000, month: d.getMonth() + 1, day: d.getDate(), weekday: d.getDay() + 1, hours: d.getHours(), minutes: d.getMinutes(), seconds: d.getSeconds() };
            })(),
          },
        });
      }
      if (req.method === 'GET' && path === '/trimlight/v1/oauth/resources/device/notify-update-shadow') {
        return find() ? reply(res, 200, { code: 0, desc: 'success' }) : reply(res, 200, { code: 10001, desc: 'no device' });
      }
      if (req.method === 'POST' && path === '/trimlight/v1/oauth/resources/device/update') {
        const device = find();
        if (!device) {
          return reply(res, 200, { code: 10001, desc: 'no device' });
        }
        if (body.payload && typeof body.payload.switchState === 'number') {
          device.switchState = body.payload.switchState;
        }
        return reply(res, 200, { code: 0, desc: 'success' });
      }
      return reply(res, 404, { code: 10001, desc: 'not found' });
    });
  });

  return { server, state };
}

module.exports = { createMockCloud };

if (require.main === module) {
  const port = Number(process.argv[2] || 8581);
  const { server, state } = createMockCloud({
    clientId: 'demo',
    clientSecret: 'demo_secret',
    devices: [{ deviceId: 'demo-device-0001', name: 'Front House', switchState: 0, connectivity: 1, state: 0, fwVersionName: '1.2.3' }],
  });
  server.listen(port, () => console.log(`Mock Trimlight cloud on http://127.0.0.1:${port}/trimlight (clientId=demo, clientSecret=demo_secret)`));
  setInterval(() => console.log('switchState:', state.devices[0].switchState), 5000);
}
