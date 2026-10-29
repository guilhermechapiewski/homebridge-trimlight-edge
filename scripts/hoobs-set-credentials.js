#!/usr/bin/env node
'use strict';
/**
 * Sets the Trimlight credentials in a HOOBS bridge config through the HOOBS
 * hub API (the same API the HOOBS app uses; HOOBS encrypts its .conf files,
 * so they can't be edited by hand).
 *
 * Useful while the HOOBS plugin directory hasn't indexed a new release and
 * the HOOBS app therefore shows no settings form for the plugin.
 *
 * Run on the HOOBS box:   node hoobs-set-credentials.js [bridge-id]
 * (bridge-id defaults to "trimlight"; see /var/lib/hoobs/bridges.conf)
 *
 * Optional env: HOOBS_URL (default http://127.0.0.1:80).
 * Prompts for the HOOBS login and the Trimlight credentials with hidden
 * input, so nothing ends up in shell history.
 */
const http = require('http');
const readline = require('readline');

const PLATFORM = 'TrimlightEdge';
const PLUGIN = 'homebridge-trimlight-edge';
const bridge = process.argv[2] || 'trimlight';
const base = new URL(process.env.HOOBS_URL || 'http://127.0.0.1:80');

function ask(question, hidden) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      // Echo nothing after the prompt.
      rl._writeToOutput = (text) => {
        if (text.indexOf(question) === 0) {
          process.stdout.write(question);
        }
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) {
        process.stdout.write('\n');
      }
      resolve(answer.trim());
    });
  });
}

function call(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const headers = { Accept: 'application/json' };
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = data.length;
    }
    if (token) {
      headers.Authorization = token;
    }
    const req = http.request({ host: base.hostname, port: base.port || 80, method, path, headers, timeout: 15000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          resolve(JSON.parse(text));
        } catch {
          reject(new Error(`${method} ${path}: HTTP ${res.statusCode}, not JSON: ${text.slice(0, 200)}`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`${method} ${path}: timed out`)));
    req.on('error', reject);
    req.end(data);
  });
}

async function main() {
  console.log(`Updating the "${PLATFORM}" settings of HOOBS bridge "${bridge}" via ${base.origin}\n`);

  const username = await ask('HOOBS username: ');
  const password = await ask('HOOBS password (hidden): ', true);
  const logon = await call('POST', '/api/auth/logon', { username, password, remember: false });
  if (!logon || typeof logon.token !== 'string' || !logon.token) {
    throw new Error(`HOOBS login failed: ${(logon && logon.error) || 'no token returned'}`);
  }
  const token = logon.token;

  const config = await call('GET', `/api/config/${encodeURIComponent(bridge)}`, undefined, token);
  if (!config || config.error || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`Could not read the config of bridge "${bridge}": ${(config && config.error) || 'unexpected response'}`);
  }
  if (!Array.isArray(config.platforms)) {
    config.platforms = [];
  }
  let entry = config.platforms.find((p) => p && p.platform === PLATFORM);
  if (entry) {
    console.log(`Found the existing ${PLATFORM} entry (fields: ${Object.keys(entry).join(', ')})`);
  } else {
    console.log(`No ${PLATFORM} entry yet; adding one`);
    entry = { platform: PLATFORM, plugin_map: { plugin_name: PLUGIN } };
    config.platforms.push(entry);
  }

  const clientId = await ask('Trimlight clientId: ');
  const clientSecret = await ask('Trimlight clientSecret (hidden): ', true);
  if (!clientId || !clientSecret) {
    throw new Error('clientId and clientSecret are both required; nothing was changed');
  }
  entry.name = entry.name || 'Trimlight Edge';
  entry.clientId = clientId;
  entry.clientSecret = clientSecret;

  const saved = await call('POST', `/api/config/${encodeURIComponent(bridge)}`, config, token);
  if (!saved || saved.success !== true) {
    throw new Error(`HOOBS did not save the config: ${(saved && saved.error) || JSON.stringify(saved)}`);
  }

  // Read it back to confirm what HOOBS stored.
  const check = await call('GET', `/api/config/${encodeURIComponent(bridge)}`, undefined, token);
  const stored = ((check && check.platforms) || []).find((p) => p && p.platform === PLATFORM) || {};
  if (stored.clientId !== clientId || stored.clientSecret !== clientSecret) {
    throw new Error('Saved, but reading the config back did not show the new credentials');
  }
  const masked = clientId.length > 6 ? `${clientId.slice(0, 3)}…${clientId.slice(-3)}` : '***';
  console.log(`\nSaved and verified (clientId ${masked}). Now restart the "${bridge}" bridge in the HOOBS app.`);
}

main().catch((error) => {
  console.error(`\nFailed: ${error.message}`);
  process.exit(1);
});
