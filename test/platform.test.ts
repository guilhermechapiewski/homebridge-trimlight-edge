import type { PlatformAccessory, PlatformConfig } from 'homebridge';
import { HomebridgeAPI } from 'homebridge/lib/api';

import { parseConfig, TrimlightPlatform } from '../src/platform';
import { PLATFORM_NAME, PLUGIN_NAME } from '../src/settings';
import { DeviceState, TrimlightAccessoryContext } from '../src/trimlightAccessory';
import { SwitchState, TrimlightApiError, TrimlightAuthError, TrimlightDevice, TrimlightDeviceDetail } from '../src/trimlightApi';
import { makeDevice, makeLogger } from './helpers';

const baseConfig: PlatformConfig = { platform: PLATFORM_NAME, clientId: 'id', clientSecret: 'secret' };

describe('parseConfig', () => {
  it('applies defaults', () => {
    expect(parseConfig(baseConfig)).toEqual({
      clientId: 'id', clientSecret: 'secret', pollingIntervalSeconds: 30, exposeAs: 'lightbulb', baseUrl: undefined,
    });
  });

  it('trims credentials and accepts overrides', () => {
    expect(parseConfig({ ...baseConfig, clientId: ' id ', pollingIntervalSeconds: '45', exposeAs: 'switch' })).toMatchObject({
      clientId: 'id', pollingIntervalSeconds: 45, exposeAs: 'switch',
    });
  });

  it('reports every problem at once', () => {
    expect(parseConfig({ platform: PLATFORM_NAME, pollingIntervalSeconds: 2, exposeAs: 'fan' })).toEqual([
      '"clientId" is required',
      '"clientSecret" is required',
      '"pollingIntervalSeconds" must be a number >= 10',
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

  const createPlatform = (config: PlatformConfig = baseConfig) => new TrimlightPlatform(log, config, api, () => client);

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

  beforeEach(() => {
    jest.useFakeTimers();
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
    await launch(createPlatform({ ...baseConfig, pollingIntervalSeconds: 15 }));
    expect(client.listDevices).toHaveBeenCalledTimes(1);
    const on = registered[0].getService(api.hap.Service.Lightbulb)!.getCharacteristic(api.hap.Characteristic.On);
    expect(on.value).toBe(false);

    setCloud(makeDevice({ switchState: SwitchState.Manual }));
    await jest.advanceTimersByTimeAsync(14_999);
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
    await jest.advanceTimersByTimeAsync(30_000);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(client.listDevices).toHaveBeenCalledTimes(3);

    setCloud(makeDevice());
    await jest.advanceTimersByTimeAsync(30_000);
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

    it('shows a timer-mode controller as off outside its schedule and on inside it', async () => {
      jest.setSystemTime(new Date(2026, 9, 28, 12, 0));
      setCloud(realController());
      await launch(createPlatform());
      const on = lightbulbOn(registered[0]);
      await expect(on.handleGetRequest()).resolves.toBe(false);

      jest.setSystemTime(new Date(2026, 9, 28, 18, 0));
      await jest.advanceTimersByTimeAsync(30_000);
      await expect(on.handleGetRequest()).resolves.toBe(true);

      jest.setSystemTime(new Date(2026, 9, 28, 21, 0));
      await jest.advanceTimersByTimeAsync(30_000);
      await expect(on.handleGetRequest()).resolves.toBe(false);
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
      await jest.advanceTimersByTimeAsync(30_000);
      await jest.advanceTimersByTimeAsync(30_000);
      await expect(on.handleGetRequest()).resolves.toBe(true);
      expect(log.warn).toHaveBeenCalledTimes(1);
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('12006'));

      client.getDeviceDetail.mockImplementation((id: string) => Promise.resolve(details[id]));
      await jest.advanceTimersByTimeAsync(30_000);
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
});
