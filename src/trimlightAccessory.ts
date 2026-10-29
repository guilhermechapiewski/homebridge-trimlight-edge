import type { API, CharacteristicValue, Logger, PlatformAccessory, Service } from 'homebridge';

import { isScheduleLit } from './schedule';
import { SwitchState, TrimlightDevice, TrimlightDeviceDetail } from './trimlightApi';

export type ExposeAs = 'lightbulb' | 'switch';

/** List-level fields merged with the detail fields that decide on/off. */
export type DeviceState = TrimlightDevice & Pick<TrimlightDeviceDetail, 'daily' | 'calendar'>;

export interface TrimlightAccessoryContext {
  device: DeviceState;
  /**
   * The controller normally runs on its timer schedule (it was last seen in
   * timer mode), so "off" from Apple Home should only last until the current
   * schedule window ends. Persisted so it survives restarts.
   */
  followsSchedule?: boolean;
  /**
   * The last switch state this plugin set, to tell its own changes apart from
   * changes made in the Trimlight app.
   */
  commandedState?: number;
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

/**
 * Whether the lights are actually lit. Timer mode is resolved against the
 * schedules (assuming lit when they can't tell); an unknown state reads as off.
 */
export function isLit(state: DeviceState, now: Date): boolean {
  switch (state.switchState) {
    case undefined:
    case SwitchState.Off:
      return false;
    case SwitchState.Timer:
      return isScheduleLit(state, now) ?? true;
    default:
      return true;
  }
}

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
  private restoringSchedule = false;

  constructor(
    private readonly deps: TrimlightAccessoryDeps,
    readonly accessory: PlatformAccessory<TrimlightAccessoryContext>,
  ) {
    const { Service: S, Characteristic: C } = deps.api.hap;
    this.cooldownMs = deps.commandCooldownMs ?? DEFAULT_COMMAND_COOLDOWN_MS;
    this.now = deps.now ?? Date.now;

    const device = accessory.context.device;
    if (device.switchState === SwitchState.Timer) {
      accessory.context.followsSchedule = true;
    }
    this.on = isLit(device, new Date(this.now()));
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
  update(device: DeviceState): void {
    const { Characteristic: C, HapStatusError, HAPStatus } = this.deps.api.hap;
    const previous = this.accessory.context.device;
    const wasOnline = this.online;
    this.online = device.connectivity === 1;

    if (this.now() < this.ignorePollsUntil) {
      // Keep the commanded switch state; the poll may predate the command.
      this.accessory.context.device = { ...device, switchState: previous.switchState };
    } else {
      this.accessory.context.device = device;
      this.trackMode(device.switchState);
      this.on = isLit(device, new Date(this.now()));
      this.restoreScheduleIfWindowOver();
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
    const context = this.accessory.context;

    // Already lit (manually or by its schedule): leave it alone. Sending
    // "manual" here would silently take the controller out of its timer
    // schedule, e.g. when Siri turns on every light in the house.
    if (turnOn && this.on) {
      this.deps.log.debug(`${name} is already on (switchState ${context.device.switchState}); nothing to do`);
      return;
    }

    let target: SwitchState;
    let description: string;
    if (turnOn) {
      target = SwitchState.Manual;
      description = `Turning ${name} on`;
    } else if (context.followsSchedule && isScheduleLit(context.device, new Date(this.now())) === false) {
      // Outside its schedule windows timer mode is dark, so going straight
      // back to it turns the lights off without dropping the schedule.
      target = SwitchState.Timer;
      description = `Turning ${name} off (back to its timer schedule)`;
    } else {
      target = SwitchState.Off;
      description = context.followsSchedule
        ? `Turning ${name} off; its timer schedule resumes once the current schedule window ends`
        : `Turning ${name} off`;
    }

    this.deps.log.info(description);
    try {
      await this.deps.client.setSwitchState(this.deviceId, target);
    } catch (error) {
      this.deps.log.error(`Failed to turn ${name} ${turnOn ? 'on' : 'off'}: ${(error as Error).message}`);
      throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }

    this.online = true;
    this.applyCommandedState(target);
    this.on = turnOn;
  }

  /**
   * Learns whether the controller normally follows its schedule. Timer mode
   * means it does; an off/manual state this plugin didn't set means someone
   * changed it in the Trimlight app, which cancels any pending restore.
   */
  private trackMode(observed: number | undefined): void {
    const context = this.accessory.context;
    if (observed === undefined) {
      return;
    }
    if (observed === SwitchState.Timer) {
      if (!context.followsSchedule || context.commandedState !== undefined) {
        context.followsSchedule = true;
        context.commandedState = undefined;
        this.persist();
      }
      return;
    }
    if (observed === context.commandedState) {
      return;
    }
    if (context.followsSchedule) {
      this.deps.log.info(`${this.accessory.displayName} was switched to ${observed === SwitchState.Off ? 'off' : 'manual'} `
        + 'outside Apple Home; its timer schedule will no longer be restored automatically');
    }
    if (context.followsSchedule || context.commandedState !== undefined) {
      context.followsSchedule = false;
      context.commandedState = undefined;
      this.persist();
    }
  }

  /**
   * After "off" during a schedule window, puts the controller back in timer
   * mode once the schedules say it should be dark, so the next window (e.g.
   * tomorrow evening) runs as usual.
   */
  private restoreScheduleIfWindowOver(): void {
    const context = this.accessory.context;
    if (!context.followsSchedule || context.commandedState !== SwitchState.Off
      || context.device.switchState !== SwitchState.Off || !this.online || this.restoringSchedule) {
      return;
    }
    if (isScheduleLit(context.device, new Date(this.now())) !== false) {
      return;
    }

    const name = this.accessory.displayName;
    this.restoringSchedule = true;
    this.deps.client.setSwitchState(this.deviceId, SwitchState.Timer)
      .then(() => {
        // Skip if a newer command superseded the "off" while this was in flight.
        if (context.commandedState === SwitchState.Off) {
          this.applyCommandedState(SwitchState.Timer);
          this.on = isLit(context.device, new Date(this.now()));
          this.deps.log.info(`${name}: schedule window over, timer schedule restored`);
        }
      })
      .catch((error) => {
        this.deps.log.warn(`Could not restore the timer schedule of ${name} (will retry): ${(error as Error).message}`);
      })
      .finally(() => {
        this.restoringSchedule = false;
      });
  }

  private applyCommandedState(target: SwitchState): void {
    const context = this.accessory.context;
    context.device = { ...context.device, switchState: target, connectivity: 1 };
    context.commandedState = target === SwitchState.Timer ? undefined : target;
    this.ignorePollsUntil = this.now() + this.cooldownMs;
    this.persist();
  }

  /** Saves the accessory context to Homebridge's cache. */
  private persist(): void {
    this.deps.api.updatePlatformAccessories([this.accessory]);
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
