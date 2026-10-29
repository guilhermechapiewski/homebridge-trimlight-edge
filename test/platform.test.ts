import type { PlatformAccessory, PlatformConfig } from 'homebridge';
import { HomebridgeAPI } from 'homebridge/lib/api';

import { parseConfig, TrimlightPlatform } from '../src/platform';
import * as timeZoneModule from '../src/timeZone';
import { PLATFORM_NAME, PLUGIN_NAME } from '../src/settings';
import { DeviceState, TrimlightAccessoryContext } from '../src/trimlightAccessory';
import { SwitchState, TrimlightApiError, TrimlightAuthError, TrimlightDevice, TrimlightDeviceDetail } from '../src/trimlightApi';
import { makeDevice, makeLogger } from './helpers';

const baseConfig: PlatformConfig = { platform: PLATFORM_NAME, clientId: 'id', clientSecret: 'secret' };

describe('parseConfig', () => {
  it('applies defaults', () => {
    expect(parseConfig(baseConfig)).toEqual({
      clientId: 'id', clientSecret: 'secret', pollingIntervalSeconds: 900, exposeAs: 'lightbulb', baseUrl: undefined,
    });
  });

  it('trims credentials and accepts overrides', () => {
    expect(parseConfig({ ...baseConfig, clientId: ' id ', pollingIntervalSeconds: '120', exposeAs: 'switch' })).toMatchObject({
      clientId: 'id', pollingIntervalSeconds: 120, exposeAs: 'switch',
    });
  });

  it('allows 0 (background checks off) and raises short intervals to the 60 s minimum', () => {
    expect(parseConfig({ ...baseConfig, pollingIntervalSeconds: 0 })).toMatchObject({ pollingIntervalSeconds: 0 });
    expect(parseConfig({ ...baseConfig, pollingIntervalSeconds: 30 })).toMatchObject({ pollingIntervalSeconds: 60 });
  });

  it('accepts a valid time zone and rejects unknown ones', () => {
    expect(parseConfig({ ...baseConfig, timezone: ' America/Los_Angeles ' })).toMatchObject({ timeZone: 'America/Los_Angeles' });
    expect(parseConfig({ ...baseConfig, timezone: '' })).toMatchObject({ timeZone: undefined });
    expect(parseConfig({ ...baseConfig, timezone: 'Pacific Time' })).toEqual([
      '"timezone" "Pacific Time" is not a known time zone (use a name like "America/Los_Angeles")',
    ]);
    expect(parseConfig({ ...baseConfig, timezone: 7 })).toEqual(['"timezone" must be a time zone name like "America/Los_Angeles"']);
  });

  it('reports every problem at once', () => {
    expect(parseConfig({ platform: PLATFORM_NAME, pollingIntervalSeconds: -1, exposeAs: 'fan' })).toEqual([
      '"clientId" is required',
      '"clientSecret" is required',
      '"pollingIntervalSeconds" must be 0 (off) or a number of seconds',
      '"exposeAs" must be "lightbulb" or "switch"',
    ]);
  });
});

describe('TrimlightPlatform', () => {
  let api: HomebridgeAPI;
  let log: ReturnType<typeof makeLogger>;
  let client: {
    listDevices: jest.Mock<Promise<TrimlightDevice[]>, []>;
    getDeviceDetail: jest.Mock<Promise<TrimlightDeviceDetail>, [string]>;
    setSwitchState: jest.Mock<Promise<void>, [string, SwitchState]>;
    notifyUpdateShadow: jest.Mock<Promise<void>, [string]>;
  };
  let registered: PlatformAccessory[];
  let unregistered: PlatformAccessory[];
  let details: Record<string, TrimlightDeviceDetail>;

  /**
   * Mimics the real cloud: the list carries no switch state; state and
   * schedules only come from the device detail.
   */
  const setCloud = (...devices: DeviceState[]) => {
    client.listDevices.mockResolvedValue(devices.map(({ switchState: _s, daily: _d, calendar: _c, ...listed }) => listed));
    details = Object.fromEntries(devices.map((d) => [d.deviceId, {
      switchState: d.switchState ?? SwitchState.Off, daily: d.daily ?? [], calendar: d.calendar ?? [],
    }]));
  };

  const createPlatform = (config: PlatformConfig = baseConfig) =>
    new TrimlightPlatform(log, config, api, () => client, { notifySettleMs: 0 });

  const launch = async (platform: TrimlightPlatform) => {
    api.signalFinished();
    // Let the initial poll's promise chain settle.
    await jest.advanceTimersByTimeAsync(0);
    return platform;
  };

  const cachedAccessory = (device: TrimlightDevice) => {
    const accessory = new api.platformAccessory<TrimlightAccessoryContext>(device.name, api.hap.uuid.generate(device.deviceId));
    accessory.context.device = device;
    return accessory;
  };

  let hostZone: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    // Tests choose the host zone explicitly; the machine running them may be on UTC.
    hostZone = jest.spyOn(timeZoneModule, 'hostTimeZone').mockReturnValue('America/Los_Angeles');
    api = new HomebridgeAPI();
    log = makeLogger();
    client = {
      listDevices: jest.fn(),
      getDeviceDetail: jest.fn((id: string) => details[id]
        ? Promise.resolve(details[id])
        : Promise.reject(new TrimlightApiError('Trimlight API error 10001: device not found', 10001))),
      setSwitchState: jest.fn().mockResolvedValue(undefined),
      notifyUpdateShadow: jest.fn().mockResolvedValue(undefined),
    };
    registered = [];
    unregistered = [];
    setCloud(makeDevice());
    jest.spyOn(api, 'registerPlatformAccessories').mockImplementation((plugin, platform, accessories) => {
      expect([plugin, platform]).toEqual([PLUGIN_NAME, PLATFORM_NAME]);
      registered.push(...accessories);
    });
    jest.spyOn(api, 'unregisterPlatformAccessories').mockImplementation((_plugin, _platform, accessories) => {
      unregistered.push(...accessories);
    });
    jest.spyOn(api, 'updatePlatformAccessories').mockImplementation(() => undefined);
  });

  afterEach(() => {
    api.signalShutdown();
    jest.useRealTimers();
    hostZone.mockRestore();
  });

  it('logs config errors and does nothing else', async () => {
    createPlatform({ platform: PLATFORM_NAME });
    api.signalFinished();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('"clientId" is required'));
    expect(client.listDevices).not.toHaveBeenCalled();
  });

  it('does not call the cloud before Homebridge finishes launching', () => {
    createPlatform();
    expect(client.listDevices).not.toHaveBeenCalled();
  });

  it('registers newly discovered devices with a HomeKit-safe name', async () => {
    setCloud(makeDevice({ deviceId: 'dev-a', name: '#Roof!' }), makeDevice({ deviceId: 'dev-b', name: 'Fence' }));
    await launch(createPlatform());

    expect(registered.map((a) => a.displayName)).toEqual(['Roof', 'Fence']);
    expect(registered[0].UUID).toBe(api.hap.uuid.generate('dev-a'));
    expect((registered[0].context as TrimlightAccessoryContext).device.deviceId).toBe('dev-a');
  });

  it('reuses cached accessories instead of registering duplicates', async () => {
    const device = makeDevice({ switchState: SwitchState.Manual });
    setCloud(device);
    const platform = createPlatform();
    const cached = cachedAccessory(makeDevice({ switchState: SwitchState.Off }));
    platform.configureAccessory(cached);
    await launch(platform);

    expect(registered).toHaveLength(0);
    expect(api.updatePlatformAccessories).toHaveBeenCalledWith([cached]);
    expect(cached.context.device).toEqual({ ...device, daily: [], calendar: [] });
    const on = cached.getService(api.hap.Service.Lightbulb)!.getCharacteristic(api.hap.Characteristic.On);
    await expect(on.handleGetRequest()).resolves.toBe(true);
  });

  it('removes accessories whose devices left the account', async () => {
    const platform = createPlatform();
    const gone = cachedAccessory(makeDevice({ deviceId: 'gone', name: 'Old' }));
    platform.configureAccessory(gone);
    await launch(platform);

    expect(unregistered).toEqual([gone]);
  });

  it('keeps accessories when the cloud returns an empty list', async () => {
    setCloud();
    const platform = createPlatform();
    platform.configureAccessory(cachedAccessory(makeDevice()));
    await launch(platform);

    expect(unregistered).toHaveLength(0);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('no devices'));
  });

  it('keeps cached accessories when the cloud is unreachable at startup', async () => {
    client.listDevices.mockRejectedValue(new TrimlightApiError('Network error: ENOTFOUND'));
    const platform = createPlatform();
    platform.configureAccessory(cachedAccessory(makeDevice()));
    await launch(platform);

    expect(unregistered).toHaveLength(0);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('ENOTFOUND'));
  });

  it('polls on the configured interval and pushes state changes to HomeKit', async () => {
    await launch(createPlatform({ ...baseConfig, pollingIntervalSeconds: 120 }));
    expect(client.listDevices).toHaveBeenCalledTimes(1);
    const on = registered[0].getService(api.hap.Service.Lightbulb)!.getCharacteristic(api.hap.Characteristic.On);
    expect(on.value).toBe(false);

    setCloud(makeDevice({ switchState: SwitchState.Manual }));
    await jest.advanceTimersByTimeAsync(119_999);
    expect(client.listDevices).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(client.listDevices).toHaveBeenCalledTimes(2);
    expect(on.value).toBe(true);
  });

  it('asks online controllers (only) to report in, then reads their detail', async () => {
    setCloud(makeDevice({ deviceId: 'dev-online' }), makeDevice({ deviceId: 'dev-offline', connectivity: 0 }));
    await launch(createPlatform());
    expect(client.notifyUpdateShadow.mock.calls).toEqual([['dev-online']]);
    expect(client.getDeviceDetail.mock.calls).toEqual([['dev-online']]);
    expect(client.notifyUpdateShadow.mock.invocationCallOrder[0]).toBeLessThan(client.getDeviceDetail.mock.invocationCallOrder[0]);
  });

  it('logs repeated failures once and announces recovery', async () => {
    client.listDevices.mockRejectedValue(new TrimlightApiError('HTTP 502 from Trimlight API'));
    await launch(createPlatform());
    // Retries back off: 30 s, then 60 s.
    await jest.advanceTimersByTimeAsync(30_000);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(client.listDevices).toHaveBeenCalledTimes(3);

    setCloud(makeDevice());
    await jest.advanceTimersByTimeAsync(120_000);
    expect(log.info).toHaveBeenCalledWith('Connection to the Trimlight cloud restored');
    expect(registered).toHaveLength(1);
  });

  it('reports rejected credentials as an error', async () => {
    client.listDevices.mockRejectedValue(new TrimlightAuthError('Trimlight API error 10001: Error', 10001));
    await launch(createPlatform());
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('rejected the API credentials'));
  });

  it('stops polling on shutdown', async () => {
    await launch(createPlatform());
    api.signalShutdown();
    await jest.advanceTimersByTimeAsync(120_000);
    expect(client.listDevices).toHaveBeenCalledTimes(1);
  });

  it('wires HomeKit writes through to the cloud client', async () => {
    await launch(createPlatform());
    const on = registered[0].getService(api.hap.Service.Lightbulb)!.getCharacteristic(api.hap.Characteristic.On);
    await on.handleSetRequest(true);
    expect(client.setSwitchState).toHaveBeenCalledWith('device-1', SwitchState.Manual);
  });
  describe('on/off state from the device detail', () => {
    const lightbulbOn = (accessory: PlatformAccessory) =>
      accessory.getService(api.hap.Service.Lightbulb)!.getCharacteristic(api.hap.Characteristic.On);

    // The user's real controller: timer mode, lit 18:00-21:00 every day.
    const realController = () => makeDevice({
      switchState: SwitchState.Timer,
      daily: [
        { id: 0, enable: true, effectId: 7, repetition: 1, startTime: { hours: 18, minutes: 0 }, endTime: { hours: 21, minutes: 0 } },
        { id: 1, enable: false, effectId: 1, repetition: 0, startTime: { hours: 0, minutes: 2 }, endTime: { hours: 0, minutes: 3 } },
      ],
      calendar: [],
    });

    it('reads state from the detail even though the list has none', async () => {
      setCloud(makeDevice({ switchState: SwitchState.Manual }));
      await launch(createPlatform());
      expect((await client.listDevices())[0].switchState).toBeUndefined();
      await expect(lightbulbOn(registered[0]).handleGetRequest()).resolves.toBe(true);
    });

    it('follows the schedule window boundaries locally, without calling the cloud', async () => {
      jest.setSystemTime(new Date(2026, 9, 28, 17, 58, 30));
      setCloud(realController());
      await launch(createPlatform());
      const on = lightbulbOn(registered[0]);
      expect(on.value).toBe(false);
      const calls = () => client.listDevices.mock.calls.length + client.getDeviceDetail.mock.calls.length;
      const before = calls();

      // The once-a-minute clock tick flips it at 18:00 and back at 21:00.
      await jest.advanceTimersByTimeAsync(2 * 60_000);
      expect(on.value).toBe(true);
      expect(log.info).toHaveBeenCalledWith('Front House is now on (timer schedule)');
      jest.setSystemTime(new Date(2026, 9, 28, 20, 59, 30));
      await jest.advanceTimersByTimeAsync(60_000);
      expect(on.value).toBe(false);
      expect(calls()).toBe(before);
    });

    it('turns a timer-mode controller on (manual) when its schedule has it dark', async () => {
      jest.setSystemTime(new Date(2026, 9, 28, 12, 0));
      setCloud(realController());
      await launch(createPlatform());
      await lightbulbOn(registered[0]).handleSetRequest(true);
      expect(client.setSwitchState).toHaveBeenCalledWith('device-1', SwitchState.Manual);
    });

    it('leaves a timer-mode controller alone when asked to turn on while its schedule has it lit', async () => {
      jest.setSystemTime(new Date(2026, 9, 28, 19, 0));
      setCloud(realController());
      await launch(createPlatform());
      await lightbulbOn(registered[0]).handleSetRequest(true);
      expect(client.setSwitchState).not.toHaveBeenCalled();
    });

    it('keeps the last known state when the detail fails, logging once until it recovers', async () => {
      setCloud(makeDevice({ switchState: SwitchState.Manual }));
      await launch(createPlatform());
      const on = lightbulbOn(registered[0]);

      client.getDeviceDetail.mockRejectedValue(new TrimlightApiError('Trimlight API error 12006: Device data could not be parsed', 12006));
      // Two HomeKit reads 15 s apart each trigger a refresh; both fail.
      for (let i = 0; i < 2; i++) {
        await jest.advanceTimersByTimeAsync(15_000);
        await on.handleGetRequest();
        await jest.advanceTimersByTimeAsync(0);
      }
      expect(client.getDeviceDetail).toHaveBeenCalledTimes(3);
      await expect(on.handleGetRequest()).resolves.toBe(true);
      expect(log.warn).toHaveBeenCalledTimes(1);
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('12006'));

      client.getDeviceDetail.mockImplementation((id: string) => Promise.resolve(details[id]));
      await jest.advanceTimersByTimeAsync(15_000);
      await on.handleGetRequest();
      await jest.advanceTimersByTimeAsync(0);
      expect(log.info).toHaveBeenCalledWith('Status of Front House is available again');
    });

    it('treats an unknown state as off for a device whose detail never loaded', async () => {
      client.getDeviceDetail.mockRejectedValue(new TrimlightApiError('HTTP 502 from Trimlight API'));
      await launch(createPlatform());
      await expect(lightbulbOn(registered[0]).handleGetRequest()).resolves.toBe(false);
    });

    it('reports a credentials error from the detail call like any other auth failure', async () => {
      client.getDeviceDetail.mockRejectedValue(new TrimlightAuthError('Trimlight rejected the request: The access token expired'));
      await launch(createPlatform());
      expect(log.error).toHaveBeenCalledWith(expect.stringContaining('rejected the API credentials'));
      expect(registered).toHaveLength(0);
    });

    it('keeps the cached state of an offline controller without calling the detail', async () => {
      const platform = createPlatform();
      const cached = cachedAccessory(makeDevice({ switchState: SwitchState.Manual, connectivity: 1 }));
      platform.configureAccessory(cached);
      setCloud(makeDevice({ connectivity: 0 }));
      await launch(platform);
      expect(client.getDeviceDetail).not.toHaveBeenCalled();
      expect(cached.context.device.switchState).toBe(SwitchState.Manual);
      await expect(lightbulbOn(cached).handleGetRequest()).rejects.toBe(api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    });
  });
  describe('refreshing when HomeKit looks, instead of constant polling', () => {
    const lightbulbOn = (accessory: PlatformAccessory) =>
      accessory.getService(api.hap.Service.Lightbulb)!.getCharacteristic(api.hap.Characteristic.On);

    it('answers a HomeKit read instantly, then refreshes and pushes the new state', async () => {
      await launch(createPlatform());
      const on = lightbulbOn(registered[0]);
      client.getDeviceDetail.mockClear();
      client.notifyUpdateShadow.mockClear();

      // Changed in the Trimlight app.
      details['device-1'] = { ...details['device-1'], switchState: SwitchState.Manual };
      await jest.advanceTimersByTimeAsync(15_000);
      await expect(on.handleGetRequest()).resolves.toBe(false);
      await jest.advanceTimersByTimeAsync(0);
      expect(client.notifyUpdateShadow).toHaveBeenCalledTimes(1);
      expect(client.getDeviceDetail).toHaveBeenCalledTimes(1);
      expect(on.value).toBe(true);
      expect(log.info).toHaveBeenCalledWith('Front House is now on (manual)');
      expect(client.listDevices).toHaveBeenCalledTimes(1);
    });

    it('throttles refreshes to one per 15 s per device, sharing one that is in flight', async () => {
      await launch(createPlatform());
      const on = lightbulbOn(registered[0]);
      client.getDeviceDetail.mockClear();

      // Startup just refreshed it, so an immediate read doesn't call again.
      await on.handleGetRequest();
      await jest.advanceTimersByTimeAsync(0);
      expect(client.getDeviceDetail).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(15_000);
      await Promise.all([on.handleGetRequest(), on.handleGetRequest(), on.handleGetRequest()]);
      await jest.advanceTimersByTimeAsync(0);
      expect(client.getDeviceDetail).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(5_000);
      await on.handleGetRequest();
      await jest.advanceTimersByTimeAsync(0);
      expect(client.getDeviceDetail).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(10_000);
      await on.handleGetRequest();
      await jest.advanceTimersByTimeAsync(0);
      expect(client.getDeviceDetail).toHaveBeenCalledTimes(2);
    });

    it('waits for the controller to report in before reading its status', async () => {
      const platform = new TrimlightPlatform(log, baseConfig, api, () => client, { notifySettleMs: 2_000 });
      api.signalFinished();
      await jest.advanceTimersByTimeAsync(0);
      expect(client.notifyUpdateShadow).toHaveBeenCalledTimes(1);
      expect(client.getDeviceDetail).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1_999);
      expect(client.getDeviceDetail).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      expect(client.getDeviceDetail).toHaveBeenCalledTimes(1);
      expect(registered).toHaveLength(1);
      platform.stop();
    });

    it('runs the background check every 15 minutes by default', async () => {
      await launch(createPlatform());
      await jest.advanceTimersByTimeAsync(899_000);
      expect(client.listDevices).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1_000);
      expect(client.listDevices).toHaveBeenCalledTimes(2);
    });

    it('can turn the background check off, still retrying a failed startup', async () => {
      client.listDevices.mockRejectedValueOnce(new TrimlightApiError('Network error: ENOTFOUND'));
      await launch(createPlatform({ ...baseConfig, pollingIntervalSeconds: 0 }));
      await jest.advanceTimersByTimeAsync(30_000);
      expect(client.listDevices).toHaveBeenCalledTimes(2);
      expect(registered).toHaveLength(1);
      await jest.advanceTimersByTimeAsync(24 * 3600_000);
      expect(client.listDevices).toHaveBeenCalledTimes(2);
    });

    it('warns when an interval below the minimum is raised', () => {
      createPlatform({ ...baseConfig, pollingIntervalSeconds: 30 });
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('using 60'));
    });

    it('notices a controller going offline when HomeKit looks at it', async () => {
      await launch(createPlatform());
      const on = lightbulbOn(registered[0]);
      details['device-1'] = { ...details['device-1'], connectivity: 0 };
      await jest.advanceTimersByTimeAsync(15_000);
      await on.handleGetRequest();
      await jest.advanceTimersByTimeAsync(0);
      await expect(on.handleGetRequest()).rejects.toBe(api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      expect(log.info).toHaveBeenCalledWith('Front House is now offline');
    });

    describe('"off for tonight" restore checks the cloud first', () => {
      const schedule = {
        daily: [{ id: 0, enable: true, effectId: 7, repetition: 1, startTime: { hours: 18, minutes: 0 }, endTime: { hours: 21, minutes: 0 } }],
        calendar: [],
      };

      const offDuringWindow = async () => {
        jest.setSystemTime(new Date(2026, 9, 28, 19, 30));
        setCloud(makeDevice({ switchState: SwitchState.Timer, ...schedule }));
        // Mirror commands into the fake cloud like the real one.
        client.setSwitchState.mockImplementation(async (id: string, state: SwitchState) => {
          details[id] = { ...details[id], switchState: state };
        });
        await launch(createPlatform());
        await lightbulbOn(registered[0]).handleSetRequest(false);
        expect(details['device-1'].switchState).toBe(SwitchState.Off);
        client.getDeviceDetail.mockClear();
      };

      it('restores timer mode after the window when the cloud still says off', async () => {
        await offDuringWindow();
        jest.setSystemTime(new Date(2026, 9, 28, 20, 59, 30));
        await jest.advanceTimersByTimeAsync(60_000);
        expect(client.getDeviceDetail).toHaveBeenCalledTimes(1);
        expect(client.setSwitchState).toHaveBeenLastCalledWith('device-1', SwitchState.Timer);
        expect(details['device-1'].switchState).toBe(SwitchState.Timer);
      });

      it('does not override a change made in the Trimlight app meanwhile', async () => {
        await offDuringWindow();
        // Turned on in the Trimlight app at 20:00; Home wasn't open, so the
        // plugin doesn't know yet.
        details['device-1'] = { ...details['device-1'], switchState: SwitchState.Manual };
        jest.setSystemTime(new Date(2026, 9, 28, 20, 59, 30));
        await jest.advanceTimersByTimeAsync(60_000);
        expect(client.getDeviceDetail).toHaveBeenCalledTimes(1);
        expect(client.setSwitchState).toHaveBeenCalledTimes(1);
        expect(details['device-1'].switchState).toBe(SwitchState.Manual);
        expect(lightbulbOn(registered[0]).value).toBe(true);
      });
    });
  });
  describe('time zones (the owner\'s HOOBS box runs on UTC)', () => {
    const lightbulbOn = (accessory: PlatformAccessory) =>
      accessory.getService(api.hap.Service.Lightbulb)!.getCharacteristic(api.hap.Characteristic.On);
    const realController = () => makeDevice({
      switchState: SwitchState.Timer,
      daily: [{ id: 0, enable: true, effectId: 7, repetition: 1, startTime: { hours: 18, minutes: 0 }, endTime: { hours: 21, minutes: 0 } }],
      calendar: [],
    });
    // The moment of the bug report: 03:20 UTC = 20:20 in Los Angeles = 12:20 in Tokyo.
    const reportInstant = new Date(Date.UTC(2026, 9, 29, 3, 20, 21));

    it('evaluates the schedule in the configured zone, not the host\'s', async () => {
      jest.setSystemTime(reportInstant);
      setCloud(realController());
      await launch(createPlatform({ ...baseConfig, timezone: 'America/Los_Angeles' }));
      expect(lightbulbOn(registered[0]).value).toBe(true);
      expect(log.info).toHaveBeenCalledWith('Using time zone America/Los_Angeles for schedules');
    });

    it('shows dark for the same instant in a zone where the window has not started', async () => {
      jest.setSystemTime(reportInstant);
      setCloud(realController());
      await launch(createPlatform({ ...baseConfig, timezone: 'Asia/Tokyo' }));
      expect(lightbulbOn(registered[0]).value).toBe(false);
    });

    it('on a UTC host, says once that it is learning the controller clock (no warning)', async () => {
      hostZone.mockReturnValue('Etc/UTC');
      await launch(createPlatform());
      expect(log.info).toHaveBeenCalledWith("This host runs on UTC; learning the controller's clock for schedules (takes about a minute)");
      expect(log.warn).not.toHaveBeenCalled();
    });

    it('stays quiet on a UTC host once the clock was learned before a restart', async () => {
      hostZone.mockReturnValue('Etc/UTC');
      const platform = createPlatform();
      const cached = cachedAccessory(makeDevice());
      cached.context.clockOffsetMinutes = -420;
      platform.configureAccessory(cached);
      await launch(platform);
      expect(log.info).not.toHaveBeenCalledWith(expect.stringContaining('learning the controller'));
    });

    it('stays quiet when the host has a real local zone', async () => {
      await launch(createPlatform());
      expect(log.info).not.toHaveBeenCalledWith(expect.stringContaining('learning the controller'));
      expect(log.warn).not.toHaveBeenCalled();
    });
  });
  describe('learning the time zone from the controller clock', () => {
    it('shows the owner\'s timer schedule correctly with no time zone configured', async () => {
      const lightbulbOn = (accessory: PlatformAccessory) =>
        accessory.getService(api.hap.Service.Lightbulb)!.getCharacteristic(api.hap.Characteristic.On);
      // The bug report: 03:20 UTC, controller on Pacific time (20:20), lit 18:00-21:00.
      jest.setSystemTime(new Date(Date.UTC(2026, 9, 29, 3, 20, 21)));
      setCloud(makeDevice({
        switchState: SwitchState.Timer,
        daily: [{ id: 0, enable: true, effectId: 7, repetition: 1, startTime: { hours: 18, minutes: 0 }, endTime: { hours: 21, minutes: 0 } }],
        calendar: [],
      }));
      client.getDeviceDetail.mockImplementation(async (id: string) => {
        const pdt = new Date(Date.now() - 7 * 3600_000);
        return {
          ...details[id],
          currentDatetime: {
            year: pdt.getUTCFullYear() - 2000, month: pdt.getUTCMonth() + 1, day: pdt.getUTCDate(), weekday: pdt.getUTCDay() + 1,
            hours: pdt.getUTCHours(), minutes: pdt.getUTCMinutes(), seconds: pdt.getUTCSeconds(),
          },
        };
      });
      await launch(createPlatform());
      expect(client.getDeviceDetail).toHaveBeenCalledTimes(1);

      // The accessory asks for a confirming reading ~65 s later.
      await jest.advanceTimersByTimeAsync(65_000);
      expect(client.getDeviceDetail).toHaveBeenCalledTimes(2);
      const accessory = registered[0] as PlatformAccessory<TrimlightAccessoryContext>;
      expect(accessory.context.clockOffsetMinutes).toBe(-420);
      expect(lightbulbOn(accessory).value).toBe(true);

      // From now on, the date/time sent to Trimlight is the controller's local time.
      await jest.advanceTimersByTimeAsync(15_000);
      await lightbulbOn(accessory).handleGetRequest();
      await jest.advanceTimersByTimeAsync(0);
      expect(client.getDeviceDetail).toHaveBeenLastCalledWith('device-1', -420);
      expect(client.notifyUpdateShadow).toHaveBeenLastCalledWith('device-1', -420);
    });
  });
});
