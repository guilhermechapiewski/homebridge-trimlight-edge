import type { API, CharacteristicValue, Logger, PlatformAccessory, Service } from 'homebridge';

import { SwitchState, TrimlightDevice } from './trimlightApi';

export type ExposeAs = 'lightbulb' | 'switch';

export interface TrimlightAccessoryContext {
  device: TrimlightDevice;
}

export interface TrimlightAccessoryDeps {
  api: API;
  log: Logger;
  client: { setSwitchState(deviceId: string, state: SwitchState): Promise<void> };
  exposeAs: ExposeAs;
  /**
   * How long after a successful command polled state is ignored, so a poll
   * that raced the command cannot flip the tile back in the Home app.
   */
  commandCooldownMs?: number;
  now?: () => number;
}

const DEFAULT_COMMAND_COOLDOWN_MS = 10_000;

/** HomeKit names must start and end with a letter or number. */
export function sanitizeName(name: string | undefined, fallback = 'Trimlight'): string {
  const cleaned = (name ?? '')
    .replace(/[^\p{L}\p{N} '’.,-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  return cleaned || fallback;
}

/**
 * Exposes one Trimlight Edge controller to HomeKit as an on/off accessory.
 *
 * Reads are served from the last known state (kept fresh by the platform's
 * polling) so HomeKit is never blocked on a cloud round trip.
 */
export class TrimlightAccessory {
  private readonly service: Service;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private on: boolean;
  private online: boolean;
  private ignorePollsUntil = 0;

  constructor(
    private readonly deps: TrimlightAccessoryDeps,
    readonly accessory: PlatformAccessory<TrimlightAccessoryContext>,
  ) {
    const { Service: S, Characteristic: C } = deps.api.hap;
    this.cooldownMs = deps.commandCooldownMs ?? DEFAULT_COMMAND_COOLDOWN_MS;
    this.now = deps.now ?? Date.now;

    const device = accessory.context.device;
    this.on = device.switchState !== SwitchState.Off;
    this.online = device.connectivity === 1;

    const info = accessory.getService(S.AccessoryInformation) ?? accessory.addService(S.AccessoryInformation);
    info
      .setCharacteristic(C.Manufacturer, 'Trimlight')
      .setCharacteristic(C.Model, 'Trimlight Edge')
      .setCharacteristic(C.SerialNumber, device.deviceId);
    this.updateFirmware(device);

    // Drop the service type we are *not* using, in case the user changed
    // `exposeAs` after the accessory was first cached.
    const [wanted, unwanted]: (typeof S.Lightbulb | typeof S.Switch)[] = deps.exposeAs === 'switch'
      ? [S.Switch, S.Lightbulb]
      : [S.Lightbulb, S.Switch];
    const stale = accessory.getService(unwanted);
    if (stale) {
      accessory.removeService(stale);
    }

    const existing = accessory.getService(wanted);
    this.service = existing ?? accessory.addService(wanted, accessory.displayName);
    if (!existing) {
      this.service.setCharacteristic(C.Name, accessory.displayName);
    }

    this.service.getCharacteristic(C.On)
      .onGet(this.handleGet.bind(this))
      .onSet(this.handleSet.bind(this));
  }

  get deviceId(): string {
    return this.accessory.context.device.deviceId;
  }

  /** Applies freshly polled device data and pushes changes to HomeKit. */
  update(device: TrimlightDevice): void {
    const { Characteristic: C, HapStatusError, HAPStatus } = this.deps.api.hap;
    const previous = this.accessory.context.device;
    const wasOnline = this.online;
    this.online = device.connectivity === 1;

    if (this.now() < this.ignorePollsUntil) {
      // Keep the commanded switch state; the poll may predate the command.
      this.accessory.context.device = { ...device, switchState: previous.switchState };
    } else {
      this.accessory.context.device = device;
      this.on = device.switchState !== SwitchState.Off;
    }
    this.updateFirmware(device);

    if (wasOnline !== this.online) {
      this.deps.log.info(`${this.accessory.displayName} is now ${this.online ? 'online' : 'offline'}`);
    }

    if (this.online) {
      this.service.updateCharacteristic(C.On, this.on);
    } else {
      this.service.updateCharacteristic(C.On, new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE));
    }
  }

  private async handleGet(): Promise<CharacteristicValue> {
    if (!this.online) {
      const { HapStatusError, HAPStatus } = this.deps.api.hap;
      throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    return this.on;
  }

  private async handleSet(value: CharacteristicValue): Promise<void> {
    const { HapStatusError, HAPStatus } = this.deps.api.hap;
    const turnOn = value === true || value === 1;
    const name = this.accessory.displayName;
    const current = this.accessory.context.device.switchState;

    // Already lit (manual or timer mode): leave it alone. Sending "manual"
    // here would silently take the controller out of its timer schedule,
    // e.g. when Siri turns on every light in the house.
    if (turnOn && current !== SwitchState.Off && this.on) {
      this.deps.log.debug(`${name} is already on (switchState ${current}); nothing to do`);
      return;
    }

    const target = turnOn ? SwitchState.Manual : SwitchState.Off;
    this.deps.log.info(`Turning ${name} ${turnOn ? 'on' : 'off'}`);
    try {
      await this.deps.client.setSwitchState(this.deviceId, target);
    } catch (error) {
      this.deps.log.error(`Failed to turn ${name} ${turnOn ? 'on' : 'off'}: ${(error as Error).message}`);
      throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }

    this.on = turnOn;
    this.online = true;
    this.accessory.context.device = { ...this.accessory.context.device, switchState: target, connectivity: 1 };
    this.ignorePollsUntil = this.now() + this.cooldownMs;
  }

  private updateFirmware(device: TrimlightDevice): void {
    // HAP requires FirmwareRevision to look like x[.y[.z]] with numbers only.
    if (device.fwVersionName && /^\d+(\.\d+){0,2}$/.test(device.fwVersionName)) {
      const { Service: S, Characteristic: C } = this.deps.api.hap;
      this.accessory.getService(S.AccessoryInformation)
        ?.updateCharacteristic(C.FirmwareRevision, device.fwVersionName);
    }
  }
}
