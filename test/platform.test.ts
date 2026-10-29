import type { PlatformAccessory, PlatformConfig } from 'homebridge';
import { HomebridgeAPI } from 'homebridge/lib/api';

import { parseConfig, TrimlightPlatform } from '../src/platform';
import { PLATFORM_NAME, PLUGIN_NAME } from '../src/settings';
import { TrimlightAccessoryContext } from '../src/trimlightAccessory';
import { SwitchState, TrimlightApiError, TrimlightAuthError, TrimlightDevice } from '../src/trimlightApi';
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
    setSwitchState: jest.Mock<Promise<void>, [string, SwitchState]>;
    notifyUpdateShadow: jest.Mock<Promise<void>, [string]>;
  };
  let registered: PlatformAccessory[];
  let unregistered: PlatformAccessory[];

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
      listDevices: jest.fn().mockResolvedValue([makeDevice()]),
      setSwitchState: jest.fn().mockResolvedValue(undefined),
      notifyUpdateShadow: jest.fn().mockResolvedValue(undefined),
    };
    registered = [];
    unregistered = [];
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
    client.listDevices.mockResolvedValue([makeDevice({ deviceId: 'dev-a', name: '#Roof!' }), makeDevice({ deviceId: 'dev-b', name: 'Fence' })]);
    await launch(createPlatform());

    expect(registered.map((a) => a.displayName)).toEqual(['Roof', 'Fence']);
    expect(registered[0].UUID).toBe(api.hap.uuid.generate('dev-a'));
    expect((registered[0].context as TrimlightAccessoryContext).device.deviceId).toBe('dev-a');
  });

  it('reuses cached accessories instead of registering duplicates', async () => {
    const device = makeDevice({ switchState: SwitchState.Manual });
    client.listDevices.mockResolvedValue([device]);
    const platform = createPlatform();
    const cached = cachedAccessory(makeDevice({ switchState: SwitchState.Off }));
    platform.configureAccessory(cached);
    await launch(platform);

    expect(registered).toHaveLength(0);
    expect(api.updatePlatformAccessories).toHaveBeenCalledWith([cached]);
    expect(cached.context.device).toEqual(device);
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
    client.listDevices.mockResolvedValue([]);
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

    client.listDevices.mockResolvedValue([makeDevice({ switchState: SwitchState.Manual })]);
    await jest.advanceTimersByTimeAsync(14_999);
    expect(client.listDevices).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(client.listDevices).toHaveBeenCalledTimes(2);
    expect(on.value).toBe(true);
  });

  it('asks online controllers (only) to refresh their cloud state', async () => {
    client.listDevices.mockResolvedValue([
      makeDevice({ deviceId: 'on' }),
      makeDevice({ deviceId: 'off', connectivity: 0 }),
    ]);
    await launch(createPlatform());
    expect(client.notifyUpdateShadow.mock.calls).toEqual([['on']]);
  });

  it('logs repeated failures once and announces recovery', async () => {
    client.listDevices.mockRejectedValue(new TrimlightApiError('HTTP 502 from Trimlight API'));
    await launch(createPlatform());
    await jest.advanceTimersByTimeAsync(30_000);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(client.listDevices).toHaveBeenCalledTimes(3);

    client.listDevices.mockResolvedValue([makeDevice()]);
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
});
