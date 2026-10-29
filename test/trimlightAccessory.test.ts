import type { PlatformAccessory } from 'homebridge';
import { HomebridgeAPI } from 'homebridge/lib/api';

import { isLit, sanitizeName, TrimlightAccessory, TrimlightAccessoryContext } from '../src/trimlightAccessory';
import { SwitchState } from '../src/trimlightApi';
import type { DeviceState } from '../src/trimlightAccessory';
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

describe('isLit', () => {
  const noon = new Date(2026, 9, 28, 12, 0);
  const evening = new Date(2026, 9, 28, 19, 0);
  const schedule = { daily: [{ enable: true, repetition: 1, startTime: { hours: 18, minutes: 0 }, endTime: { hours: 21, minutes: 0 } }] };

  it.each([
    ['unknown state', { switchState: undefined }, noon, false],
    ['off', { switchState: SwitchState.Off }, evening, false],
    ['manual', { switchState: SwitchState.Manual }, noon, true],
    ['timer, outside its window', { switchState: SwitchState.Timer, ...schedule }, noon, false],
    ['timer, inside its window', { switchState: SwitchState.Timer, ...schedule }, evening, true],
    ['timer, no usable schedule (assume lit)', { switchState: SwitchState.Timer, daily: [] }, noon, true],
  ])('%s', (_label, state, now, expected) => {
    expect(isLit(makeDevice(state as Partial<DeviceState>), now)).toBe(expected);
  });
});

describe('TrimlightAccessory', () => {
  const api = new HomebridgeAPI();
  const { Service, Characteristic, HapStatusError, HAPStatus } = api.hap;

  let clock: number;
  let log: ReturnType<typeof makeLogger>;
  let client: { setSwitchState: jest.Mock<Promise<void>, [string, SwitchState]> };

  const makeAccessory = (device: DeviceState) => {
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
  describe('"off for tonight" with a timer schedule', () => {
    // The user's real schedule: lit 18:00-21:00 every day.
    const schedule = {
      daily: [{ id: 0, enable: true, effectId: 7, repetition: 1, startTime: { hours: 18, minutes: 0 }, endTime: { hours: 21, minutes: 0 } }],
      calendar: [],
    };
    const timerDevice = (overrides: Partial<DeviceState> = {}) => makeDevice({ switchState: SwitchState.Timer, ...schedule, ...overrides });
    const time = (h: number, m = 0) => new Date(2026, 9, 28, h, m).getTime();
    /** Lets the fire-and-forget restore promise settle. */
    const flush = () => new Promise((resolve) => setImmediate(resolve));
    let persisted: jest.SpyInstance;

    beforeEach(() => {
      persisted = jest.spyOn(api, 'updatePlatformAccessories');
    });

    afterEach(() => {
      persisted.mockRestore();
    });

    it('learns that a controller seen in timer mode follows its schedule', () => {
      const { accessory } = build(timerDevice());
      expect(accessory.context.followsSchedule).toBe(true);
    });

    it('turning off during the window sends off, then restores timer mode once the window ends', async () => {
      clock = time(19, 30);
      const { handler, on, accessory } = build(timerDevice());
      await expect(on.handleGetRequest()).resolves.toBe(true);

      await on.handleSetRequest(false);
      expect(client.setSwitchState).toHaveBeenLastCalledWith('device-1', SwitchState.Off);
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining('resumes once the current schedule window ends'));
      expect(accessory.context.commandedState).toBe(SwitchState.Off);
      expect(persisted).toHaveBeenCalledWith([accessory]);

      // Still inside the window: stays off, no restore yet.
      clock = time(20, 30);
      handler.update(timerDevice({ switchState: SwitchState.Off }));
      await flush();
      expect(client.setSwitchState).toHaveBeenCalledTimes(1);
      await expect(on.handleGetRequest()).resolves.toBe(false);

      // Window over: back to timer mode, still dark.
      clock = time(21, 0);
      handler.update(timerDevice({ switchState: SwitchState.Off }));
      await flush();
      expect(client.setSwitchState).toHaveBeenLastCalledWith('device-1', SwitchState.Timer);
      expect(accessory.context.device.switchState).toBe(SwitchState.Timer);
      expect(accessory.context.commandedState).toBeUndefined();
      expect(accessory.context.followsSchedule).toBe(true);
      await expect(on.handleGetRequest()).resolves.toBe(false);
      expect(log.info).toHaveBeenCalledWith('Front House: schedule window over, timer schedule restored');

      // Tomorrow evening the schedule lights it again.
      clock = time(21, 0) + 21 * 3600_000;
      handler.update(timerDevice());
      await expect(on.handleGetRequest()).resolves.toBe(true);
      expect(client.setSwitchState).toHaveBeenCalledTimes(2);
    });

    it('turning off after "on" outside the window goes straight back to timer mode', async () => {
      clock = time(12, 0);
      const { on, accessory } = build(timerDevice());
      await on.handleSetRequest(true);
      expect(client.setSwitchState).toHaveBeenLastCalledWith('device-1', SwitchState.Manual);
      expect(accessory.context.followsSchedule).toBe(true);

      await on.handleSetRequest(false);
      expect(client.setSwitchState).toHaveBeenLastCalledWith('device-1', SwitchState.Timer);
      expect(accessory.context.device.switchState).toBe(SwitchState.Timer);
      await expect(on.handleGetRequest()).resolves.toBe(false);
    });

    it('retries a failed restore on the next refresh', async () => {
      clock = time(19, 30);
      const { handler, on } = build(timerDevice());
      await on.handleSetRequest(false);

      client.setSwitchState.mockRejectedValueOnce(new Error('cloud down'));
      clock = time(21, 1);
      handler.update(timerDevice({ switchState: SwitchState.Off }));
      await flush();
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('cloud down'));

      clock = time(21, 2);
      handler.update(timerDevice({ switchState: SwitchState.Off }));
      await flush();
      expect(client.setSwitchState).toHaveBeenLastCalledWith('device-1', SwitchState.Timer);
      expect(client.setSwitchState).toHaveBeenCalledTimes(3);
    });

    it('does not restore while the controller is offline', async () => {
      clock = time(19, 30);
      const { handler, on } = build(timerDevice());
      await on.handleSetRequest(false);
      clock = time(21, 1);
      handler.update(timerDevice({ switchState: SwitchState.Off, connectivity: 0 }));
      await flush();
      expect(client.setSwitchState).toHaveBeenCalledTimes(1);
    });

    it('cancels the restore when the mode is changed in the Trimlight app', async () => {
      clock = time(19, 30);
      const { handler, on, accessory } = build(timerDevice());
      await on.handleSetRequest(false);

      clock = time(20, 0);
      handler.update(timerDevice({ switchState: SwitchState.Manual }));
      expect(accessory.context.followsSchedule).toBe(false);
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining('switched to manual outside Apple Home'));

      clock = time(21, 30);
      handler.update(timerDevice({ switchState: SwitchState.Off }));
      await flush();
      expect(client.setSwitchState).toHaveBeenCalledTimes(1);
    });

    it('cancels the restore when turned back on from Apple Home', async () => {
      clock = time(19, 30);
      const { handler, on } = build(timerDevice());
      await on.handleSetRequest(false);
      clock = time(19, 45);
      await on.handleSetRequest(true);
      expect(client.setSwitchState).toHaveBeenLastCalledWith('device-1', SwitchState.Manual);

      clock = time(21, 30);
      handler.update(timerDevice({ switchState: SwitchState.Manual }));
      await flush();
      expect(client.setSwitchState).toHaveBeenCalledTimes(2);
      await expect(on.handleGetRequest()).resolves.toBe(true);
    });

    it('ignores polls during the command cooldown for restore decisions', async () => {
      // Off at 20:59:58; the window ends 2s later, inside the 10s cooldown.
      clock = time(21, 0) - 2_000;
      const { handler, on } = build(timerDevice());
      await on.handleSetRequest(false);
      clock = time(21, 0) + 3_000;
      handler.update(timerDevice({ switchState: SwitchState.Timer }));
      await flush();
      expect(client.setSwitchState).toHaveBeenCalledTimes(1);
      clock = time(21, 0) + 15_000;
      handler.update(timerDevice({ switchState: SwitchState.Off }));
      await flush();
      expect(client.setSwitchState).toHaveBeenLastCalledWith('device-1', SwitchState.Timer);
    });

    it('plain off for a controller that never ran a schedule', async () => {
      clock = time(12, 0);
      const { on, accessory } = build(makeDevice({ switchState: SwitchState.Manual, ...schedule }));
      expect(accessory.context.followsSchedule).toBeUndefined();
      await on.handleSetRequest(false);
      expect(client.setSwitchState).toHaveBeenLastCalledWith('device-1', SwitchState.Off);
    });

    it('survives a restart: the persisted context still restores the schedule', async () => {
      clock = time(19, 30);
      const first = build(timerDevice());
      await first.on.handleSetRequest(false);

      // New handler on the same (cached) accessory, as after a HOOBS restart.
      clock = time(21, 5);
      const second = build(timerDevice({ switchState: SwitchState.Off }), 'lightbulb', first.accessory);
      second.handler.update(timerDevice({ switchState: SwitchState.Off }));
      await flush();
      expect(client.setSwitchState).toHaveBeenLastCalledWith('device-1', SwitchState.Timer);
    });
  });
});
