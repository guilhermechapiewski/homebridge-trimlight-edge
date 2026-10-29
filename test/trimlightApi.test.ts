import {
  generateAccessToken,
  SwitchState,
  toTrimlightDate,
  TrimlightApiError,
  TrimlightAuthError,
  TrimlightClient,
  TrimlightClientOptions,
} from '../src/trimlightApi';
import { makeDevice, MockServer } from './helpers';

describe('generateAccessToken', () => {
  it('matches the example in the Trimlight API documentation', () => {
    expect(generateAccessToken('tester', 'test_secret', 1713166849256))
      .toBe('z02N77XySuOwv5OSUe0vrPwprRITb656xKPulS9ooXI=');
  });
});

describe('toTrimlightDate', () => {
  it('converts to years since 2000 and Sunday-based 1..7 weekdays', () => {
    // Sunday, 2024-04-14 09:05:07 local time.
    expect(toTrimlightDate(new Date(2024, 3, 14, 9, 5, 7))).toEqual({
      year: 24, month: 4, day: 14, weekday: 1, hours: 9, minutes: 5, seconds: 7,
    });
    // Saturday.
    expect(toTrimlightDate(new Date(2024, 3, 20)).weekday).toBe(7);
  });
});

describe('TrimlightClient', () => {
  let server: MockServer;
  let baseUrl: string;

  const client = (overrides: Partial<TrimlightClientOptions> = {}) => new TrimlightClient({
    clientId: 'tester',
    clientSecret: 'test_secret',
    baseUrl,
    minRequestIntervalMs: 0,
    retryBaseDelayMs: 1,
    timeoutMs: 1000,
    ...overrides,
  });

  beforeEach(async () => {
    server = new MockServer();
    baseUrl = await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('requires credentials', () => {
    expect(() => new TrimlightClient({ clientId: '', clientSecret: 'x' })).toThrow(/required/);
    expect(() => new TrimlightClient({ clientId: 'x', clientSecret: '' })).toThrow(/required/);
  });

  describe('listDevices', () => {
    it('sends an authenticated GET with a JSON body and returns devices', async () => {
      const device = makeDevice();
      server.handler = () => ({ body: { code: 0, desc: 'success', payload: { total: 1, current: 0, data: [device] } } });

      const devices = await client().listDevices();

      expect(devices).toEqual([device]);
      expect(server.requests).toHaveLength(1);
      const [req] = server.requests;
      expect(req.method).toBe('GET');
      expect(req.path).toBe('/trimlight/v1/oauth/resources/devices');
      expect(req.body).toEqual({ page: 0 });
      expect(req.headers['content-type']).toBe('application/json');
      expect(req.headers['s-clientid']).toBe('tester');
      const timestamp = Number(req.headers['s-timestamp']);
      expect(Math.abs(timestamp - Date.now())).toBeLessThan(5000);
      expect(req.headers.authorization).toBe(generateAccessToken('tester', 'test_secret', timestamp));
    });

    it('preserves the base path when baseUrl has a trailing slash', async () => {
      server.handler = () => ({ body: { code: 0, payload: { data: [] } } });
      await client({ baseUrl: `${baseUrl}/` }).listDevices();
      expect(server.requests[0].path).toBe('/trimlight/v1/oauth/resources/devices');
    });

    it('drops malformed device entries', async () => {
      const good = makeDevice();
      server.handler = () => ({ body: { code: 0, payload: { data: [good, null, 'x', {}, { deviceId: '' }] } } });
      await expect(client().listDevices()).resolves.toEqual([good]);
    });

    it('rejects when the payload has no data array', async () => {
      server.handler = () => ({ body: { code: 0, payload: {} } });
      await expect(client().listDevices()).rejects.toThrow(/missing data array/);
    });
  });

  describe('getDeviceDetail', () => {
    it('POSTs the device id with the current date and returns the payload', async () => {
      const now = new Date(2025, 0, 2, 3, 4, 5);
      server.handler = () => ({ body: { code: 0, payload: { name: 'x', switchState: 1 } } });
      await expect(client({ now: () => now }).getDeviceDetail('abc')).resolves.toEqual({ name: 'x', switchState: 1 });
      expect(server.requests[0].method).toBe('POST');
      expect(server.requests[0].path).toBe('/trimlight/v1/oauth/resources/device/get');
      expect(server.requests[0].body).toEqual({ deviceId: 'abc', currentDate: toTrimlightDate(now) });
    });

    it('rejects a success response without a payload', async () => {
      server.handler = () => ({ body: { code: 0 } });
      await expect(client().getDeviceDetail('abc')).rejects.toThrow(/missing payload/);
    });
  });

  describe('setSwitchState', () => {
    it.each([
      [SwitchState.Off, 0],
      [SwitchState.Manual, 1],
    ])('POSTs switchState %s', async (state, expected) => {
      await client().setSwitchState('abc', state);
      expect(server.requests).toHaveLength(1);
      expect(server.requests[0].method).toBe('POST');
      expect(server.requests[0].path).toBe('/trimlight/v1/oauth/resources/device/update');
      expect(server.requests[0].body).toEqual({ deviceId: 'abc', payload: { switchState: expected } });
    });
  });

  describe('error handling', () => {
    it('raises TrimlightApiError with the result code and does not retry ordinary API errors', async () => {
      server.handler = () => ({ body: { code: 12345, desc: 'nope' } });
      const error = await client().setSwitchState('abc', SwitchState.Off).catch((e) => e);
      expect(error).toBeInstanceOf(TrimlightApiError);
      expect(error).not.toBeInstanceOf(TrimlightAuthError);
      expect(error.code).toBe(12345);
      expect(error.message).toContain('nope');
      expect(server.requests).toHaveLength(1);
    });

    it('raises TrimlightAuthError for result code 10001 without retrying', async () => {
      server.handler = () => ({ body: { code: 10001, desc: 'Error' } });
      await expect(client().listDevices()).rejects.toBeInstanceOf(TrimlightAuthError);
      expect(server.requests).toHaveLength(1);
    });

    it.each([401, 403])('raises TrimlightAuthError for HTTP %s', async (status) => {
      server.handler = () => ({ status, raw: 'denied' });
      await expect(client().listDevices()).rejects.toBeInstanceOf(TrimlightAuthError);
      expect(server.requests).toHaveLength(1);
    });

    it('raises TrimlightAuthError for the real gateway response to bad credentials (HTTP 207 + OAuth error)', async () => {
      // Captured from https://trimlight.ledhue.com with invalid credentials.
      server.handler = () => ({ status: 207, body: { error: 'invalid_token', error_description: 'The access token expired' } });
      const error = await client().listDevices().catch((e) => e);
      expect(error).toBeInstanceOf(TrimlightAuthError);
      expect(error.message).toContain('The access token expired');
      expect(error.message).toContain('clock');
      expect(server.requests).toHaveLength(1);
    });

    it('raises a non-auth error for other OAuth-style errors', async () => {
      server.handler = () => ({ status: 207, body: { error: 'invalid_request', error_description: 'Bad thing' } });
      const error = await client().listDevices().catch((e) => e);
      expect(error).toBeInstanceOf(TrimlightApiError);
      expect(error).not.toBeInstanceOf(TrimlightAuthError);
      expect(error.message).toContain('Bad thing');
    });

    it('retries the rate-limit result code 20000 and then succeeds', async () => {
      let calls = 0;
      server.handler = () => (++calls < 3 ? { body: { code: 20000, desc: 'busy' } } : { body: { code: 0 } });
      await client().setSwitchState('abc', SwitchState.Manual);
      expect(server.requests).toHaveLength(3);
    });

    it('retries 5xx responses up to maxAttempts then fails', async () => {
      server.handler = () => ({ status: 502, raw: 'bad gateway' });
      const error = await client({ maxAttempts: 3 }).listDevices().catch((e) => e);
      expect(error).toBeInstanceOf(TrimlightApiError);
      expect(error.status).toBe(502);
      expect(server.requests).toHaveLength(3);
    });

    it('does not retry other 4xx responses', async () => {
      server.handler = () => ({ status: 404, raw: 'not found' });
      await expect(client().listDevices()).rejects.toThrow(/HTTP 404/);
      expect(server.requests).toHaveLength(1);
    });

    it('rejects non-JSON and malformed bodies', async () => {
      server.handler = () => ({ raw: '<html>oops</html>' });
      await expect(client().listDevices()).rejects.toThrow(/Invalid JSON/);
      server.handler = () => ({ body: { hello: 'world' } });
      await expect(client().listDevices()).rejects.toThrow(/Unexpected response/);
    });

    it('times out hung requests and retries them', async () => {
      server.handler = () => ({ hang: true });
      const error = await client({ timeoutMs: 50, maxAttempts: 2 }).listDevices().catch((e) => e);
      expect(error).toBeInstanceOf(TrimlightApiError);
      expect(error.message).toMatch(/timed out/);
      expect(server.requests).toHaveLength(2);
    });

    it('reports network errors as retryable TrimlightApiError', async () => {
      await server.stop();
      const error = await client({ maxAttempts: 2 }).listDevices().catch((e) => e);
      expect(error).toBeInstanceOf(TrimlightApiError);
      expect(error.retryable).toBe(true);
      expect(error.message).toMatch(/Network error/);
      server = new MockServer();
      baseUrl = await server.start();
    });
  });

  describe('request scheduling', () => {
    it('never sends requests concurrently and spaces them out', async () => {
      server.handler = () => ({ body: { code: 0, payload: { data: [] } }, delayMs: 20 });
      const c = client({ minRequestIntervalMs: 50 });

      await Promise.all([
        c.listDevices(),
        c.setSwitchState('a', SwitchState.Manual),
        c.setSwitchState('b', SwitchState.Off),
      ]);

      expect(server.maxInFlight).toBe(1);
      const times = server.requests.map((r) => r.receivedAt);
      for (let i = 1; i < times.length; i++) {
        // Gap is measured from response end, so request starts are >= 50ms + 20ms apart.
        expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(45);
      }
    });

    it('keeps processing the queue after a failed request', async () => {
      let calls = 0;
      server.handler = () => (++calls === 1 ? { status: 404 } : { body: { code: 0 } });
      const c = client();
      const results = await Promise.allSettled([
        c.setSwitchState('a', SwitchState.Manual),
        c.setSwitchState('b', SwitchState.Off),
      ]);
      expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled']);
    });
  });

  it('sends currentDate as wall-clock time in the configured time zone', async () => {
    const now = new Date(Date.UTC(2026, 9, 29, 3, 20, 21));
    server.handler = () => ({ body: { code: 0, payload: {} } });
    await client({ now: () => now, timeZone: 'America/Los_Angeles' }).getDeviceDetail('abc');
    await client({ now: () => now, timeZone: 'America/Los_Angeles' }).notifyUpdateShadow('abc');
    const expected = { year: 26, month: 10, day: 28, weekday: 4, hours: 20, minutes: 20, seconds: 21 };
    expect((server.requests[0].body as { currentDate: unknown }).currentDate).toEqual(expected);
    expect((server.requests[1].body as { currentDate: unknown }).currentDate).toEqual(expected);
  });

  describe('notifyUpdateShadow', () => {
    it('sends the device id and current date', async () => {
      const now = new Date(2025, 0, 2, 3, 4, 5);
      await client({ now: () => now }).notifyUpdateShadow('abc');
      expect(server.requests[0].method).toBe('GET');
      expect(server.requests[0].path).toBe('/trimlight/v1/oauth/resources/device/notify-update-shadow');
      expect(server.requests[0].body).toEqual({ deviceId: 'abc', currentDate: toTrimlightDate(now) });
    });

    it('swallows failures and does not retry', async () => {
      server.handler = () => ({ status: 500 });
      const debug = jest.fn();
      await expect(client({ debug }).notifyUpdateShadow('abc')).resolves.toBeUndefined();
      expect(server.requests).toHaveLength(1);
      expect(debug).toHaveBeenCalledWith(expect.stringContaining('notify-update-shadow failed'));
    });
  });

  it('never leaks the client secret into debug logs', async () => {
    server.handler = () => ({ status: 503 });
    const debug = jest.fn();
    await client({ debug, maxAttempts: 2 }).listDevices().catch(() => undefined);
    expect(debug).toHaveBeenCalled();
    for (const [message] of debug.mock.calls) {
      expect(message).not.toContain('test_secret');
    }
  });
});
