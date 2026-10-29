import type { PlatformAccessory } from 'homebridge';
import { HomebridgeAPI } from 'homebridge/lib/api';

import { sanitizeName, TrimlightAccessory, TrimlightAccessoryContext } from '../src/trimlightAccessory';
import { SwitchState, TrimlightDevice } from '../src/trimlightApi';
import { makeDevice, makeLogger } from './helpers';

describe('sanitizeName', () => {
  it.each([
    ['Front House', 'Front House'],
    ['  #Roof Line!  ', 'Roof Line'],
    ["Guilherme's   Lights", "Guilherme's Lights"],
    ['Casa Ação 2', 'Casa Ação 2'],
    ['***', 'Trimlight'],
    [undefined, 'Trimlight'],
  ])('%p -> %p', (input, expected) => {
    expect(sanitizeName(input)).toBe(expected);
  });
});

describe('TrimlightAccessory', () => {
  const api = new HomebridgeAPI();
  const { Service, Characteristic, HapStatusError, HAPStatus } = api.hap;

  let clock: number;
  let log: ReturnType<typeof makeLogger>;
  let client: { setSwitchState: jest.Mock<Promise<void>, [string, SwitchState]> };

  const makeAccessory = (device: TrimlightDevice) => {
    const accessory = new api.platformAccessory<TrimlightAccessoryContext>(device.name, api.hap.uuid.generate(device.deviceId));
    accessory.context.device = device;
    return accessory;
  };

  const build = (device = makeDevice(), exposeAs: 'lightbulb' | 'switch' = 'lightbulb', accessory?: PlatformAccessory<TrimlightAccessoryContext>) => {
    const acc = accessory ?? makeAccessory(device);
    const handler = new TrimlightAccessory({ api, log, client, exposeAs, commandCooldownMs: 10_000, now: () => clock }, acc);
    const service = acc.getService(exposeAs === 'switch' ? Service.Switch : Service.Lightbulb)!;
    return { handler, accessory: acc, service, on: service.getCharacteristic(Characteristic.On) };
  };

  beforeEach(() => {
    clock = 1_000_000;
    log = makeLogger();
    client = { setSwitchState: jest.fn().mockResolvedValue(undefined) };
  });

  describe('setup', () => {
    it('exposes a Lightbulb with only the On characteristic by default', () => {
      const { accessory, service } = build();
      expect(service).toBeDefined();
      expect(accessory.getService(Service.Switch)).toBeUndefined();
      expect(service.getCharacteristic(Characteristic.Name).value).toBe('Front House');
      expect(service.testCharacteristic(Characteristic.Brightness)).toBe(false);
    });

    it('can expose a Switch instead', () => {
      const { accessory, service } = build(makeDevice(), 'switch');
      expect(service).toBeDefined();
      expect(accessory.getService(Service.Lightbulb)).toBeUndefined();
    });

    it('replaces a previously cached service type when exposeAs changes', () => {
      const { accessory } = build(makeDevice(), 'lightbulb');
      const rebuilt = build(makeDevice(), 'switch', accessory);
      expect(rebuilt.accessory.getService(Service.Lightbulb)).toBeUndefined();
      expect(rebuilt.accessory.getService(Service.Switch)).toBeDefined();
      expect(rebuilt.accessory.services.filter((s) => s.UUID === Service.Switch.UUID)).toHaveLength(1);
    });

    it('reuses an existing service on restart instead of duplicating it', () => {
      const { accessory } = build();
      build(makeDevice(), 'lightbulb', accessory);
      expect(accessory.services.filter((s) => s.UUID === Service.Lightbulb.UUID)).toHaveLength(1);
    });

    it('fills in accessory information', () => {
      const { accessory } = build(makeDevice({ deviceId: 'abc123', fwVersionName: '1.4.0' }));
      const info = accessory.getService(Service.AccessoryInformation)!;
      expect(info.getCharacteristic(Characteristic.Manufacturer).value).toBe('Trimlight');
      expect(info.getCharacteristic(Characteristic.Model).value).toBe('Trimlight Edge');
      expect(info.getCharacteristic(Characteristic.SerialNumber).value).toBe('abc123');
      expect(info.getCharacteristic(Characteristic.FirmwareRevision).value).toBe('1.4.0');
    });

    it('ignores firmware versions HomeKit would reject', () => {
      const { accessory } = build(makeDevice({ fwVersionName: 'v1.4-beta' }));
      const info = accessory.getService(Service.AccessoryInformation)!;
      expect(info.getCharacteristic(Characteristic.FirmwareRevision).value).not.toBe('v1.4-beta');
    });
  });

  describe('reading state', () => {
    it.each([
      [SwitchState.Off, false],
      [SwitchState.Manual, true],
      [SwitchState.Timer, true],
    ])('switchState %s reads as on=%s without calling the cloud', async (switchState, expected) => {
      const { on } = build(makeDevice({ switchState }));
      await expect(on.handleGetRequest()).resolves.toBe(expected);
      expect(client.setSwitchState).not.toHaveBeenCalled();
    });

    it('reports No Response while the controller is offline', async () => {
      const { on } = build(makeDevice({ connectivity: 0 }));
      await expect(on.handleGetRequest()).rejects.toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    });
  });

  describe('turning on and off', () => {
    it('turns on using manual mode', async () => {
      const { on, accessory } = build(makeDevice({ switchState: SwitchState.Off }));
      await on.handleSetRequest(true);
      expect(client.setSwitchState).toHaveBeenCalledWith('device-1', SwitchState.Manual);
      await expect(on.handleGetRequest()).resolves.toBe(true);
      expect(accessory.context.device.switchState).toBe(SwitchState.Manual);
    });

    it('turns off', async () => {
      const { on } = build(makeDevice({ switchState: SwitchState.Manual }));
      await on.handleSetRequest(false);
      expect(client.setSwitchState).toHaveBeenCalledWith('device-1', SwitchState.Off);
      await expect(on.handleGetRequest()).resolves.toBe(false);
    });

    it('does not knock a lit controller out of timer mode when asked to turn on', async () => {
      const { on, accessory } = build(makeDevice({ switchState: SwitchState.Timer }));
      await on.handleSetRequest(true);
      expect(client.setSwitchState).not.toHaveBeenCalled();
      expect(accessory.context.device.switchState).toBe(SwitchState.Timer);
    });

    it('still sends off when already off (idempotent, keeps cloud in sync)', async () => {
      const { on } = build(makeDevice({ switchState: SwitchState.Off }));
      await on.handleSetRequest(false);
      expect(client.setSwitchState).toHaveBeenCalledWith('device-1', SwitchState.Off);
    });

    it('surfaces cloud failures to HomeKit and keeps the previous state', async () => {
      client.setSwitchState.mockRejectedValue(new Error('boom'));
      const { on } = build(makeDevice({ switchState: SwitchState.Off }));
      await expect(on.handleSetRequest(true)).rejects.toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      await expect(on.handleGetRequest()).resolves.toBe(false);
      expect(log.error).toHaveBeenCalledWith(expect.stringContaining('boom'));
    });
  });

  describe('applying polled state', () => {
    it('pushes changes to HomeKit', () => {
      const { handler, on } = build(makeDevice({ switchState: SwitchState.Off }));
      handler.update(makeDevice({ switchState: SwitchState.Manual }));
      expect(on.value).toBe(true);
      handler.update(makeDevice({ switchState: SwitchState.Off }));
      expect(on.value).toBe(false);
    });

    it('ignores stale polls shortly after a command, then resumes', async () => {
      const { handler, on } = build(makeDevice({ switchState: SwitchState.Off }));
      await on.handleSetRequest(true);

      clock += 5_000;
      handler.update(makeDevice({ switchState: SwitchState.Off }));
      await expect(on.handleGetRequest()).resolves.toBe(true);

      clock += 6_000;
      handler.update(makeDevice({ switchState: SwitchState.Off }));
      await expect(on.handleGetRequest()).resolves.toBe(false);
    });

    it('goes No Response when the controller drops offline and recovers', async () => {
      const { handler, on } = build(makeDevice({ switchState: SwitchState.Manual }));
      const statusUpdates: unknown[] = [];
      jest.spyOn(on, 'updateValue').mockImplementation(((value: unknown) => {
        statusUpdates.push(value);
        return on;
      }) as never);

      handler.update(makeDevice({ switchState: SwitchState.Manual, connectivity: 0 }));
      await expect(on.handleGetRequest()).rejects.toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      expect(statusUpdates[0]).toBeInstanceOf(HapStatusError);
      expect(log.info).toHaveBeenCalledWith('Front House is now offline');

      handler.update(makeDevice({ switchState: SwitchState.Manual, connectivity: 1 }));
      await expect(on.handleGetRequest()).resolves.toBe(true);
      expect(log.info).toHaveBeenCalledWith('Front House is now online');
    });
  });
});
