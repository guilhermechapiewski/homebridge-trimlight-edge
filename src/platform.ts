import type { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig } from 'homebridge';

import {
  CLOCK_TICK_MS,
  DEFAULT_POLLING_INTERVAL_SECONDS,
  MIN_POLLING_INTERVAL_SECONDS,
  NOTIFY_SETTLE_MS,
  ON_DEMAND_REFRESH_MIN_INTERVAL_MS,
  PLATFORM_NAME,
  PLUGIN_NAME,
  POLL_RETRY_INITIAL_MS,
} from './settings';
import { DeviceState, ExposeAs, sanitizeName, TrimlightAccessory, TrimlightAccessoryContext } from './trimlightAccessory';
import { TrimlightAuthError, TrimlightClient, TrimlightDevice } from './trimlightApi';

export interface TrimlightPlatformConfig {
  clientId: string;
  clientSecret: string;
  /** Background check interval; 0 means only at startup and on demand. */
  pollingIntervalSeconds: number;
  exposeAs: ExposeAs;
  /** Undocumented; lets tests point the plugin at a mock server. */
  baseUrl?: string;
}

/** Timing knobs, overridable in tests. */
export interface PlatformTiming {
  notifySettleMs: number;
  refreshMinIntervalMs: number;
  clockTickMs: number;
  retryInitialMs: number;
}

type Client = Pick<TrimlightClient, 'listDevices' | 'getDeviceDetail' | 'setSwitchState' | 'notifyUpdateShadow'>;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Validates the raw Homebridge config, returning a list of problems if invalid. */
export function parseConfig(config: PlatformConfig): TrimlightPlatformConfig | string[] {
  const errors: string[] = [];
  const clientId = typeof config.clientId === 'string' ? config.clientId.trim() : '';
  const clientSecret = typeof config.clientSecret === 'string' ? config.clientSecret.trim() : '';
  if (!clientId) {
    errors.push('"clientId" is required');
  }
  if (!clientSecret) {
    errors.push('"clientSecret" is required');
  }

  let pollingIntervalSeconds = DEFAULT_POLLING_INTERVAL_SECONDS;
  if (config.pollingIntervalSeconds !== undefined && config.pollingIntervalSeconds !== null && config.pollingIntervalSeconds !== '') {
    const parsed = Number(config.pollingIntervalSeconds);
    if (!Number.isFinite(parsed) || parsed < 0) {
      errors.push('"pollingIntervalSeconds" must be 0 (off) or a number of seconds');
    } else {
      // Short intervals from older versions are raised rather than rejected.
      pollingIntervalSeconds = parsed === 0 ? 0 : Math.max(parsed, MIN_POLLING_INTERVAL_SECONDS);
    }
  }

  let exposeAs: ExposeAs = 'lightbulb';
  if (config.exposeAs !== undefined && config.exposeAs !== null && config.exposeAs !== '') {
    if (config.exposeAs === 'lightbulb' || config.exposeAs === 'switch') {
      exposeAs = config.exposeAs;
    } else {
      errors.push('"exposeAs" must be "lightbulb" or "switch"');
    }
  }

  if (errors.length) {
    return errors;
  }
  return {
    clientId,
    clientSecret,
    pollingIntervalSeconds,
    exposeAs,
    baseUrl: typeof config.baseUrl === 'string' && config.baseUrl ? config.baseUrl : undefined,
  };
}

/**
 * Keeps HomeKit in sync with the Trimlight cloud without constant polling:
 * - a full check (device list + status) at startup and every
 *   `pollingIntervalSeconds` (default 15 min; 0 = off);
 * - an on-demand status refresh whenever HomeKit reads an accessory (the Home
 *   app, a widget or Siri looking at it), throttled per device;
 * - schedule windows are tracked locally by each accessory (no API calls).
 */
export class TrimlightPlatform implements DynamicPlatformPlugin {
  /** Accessories restored from the Homebridge cache, keyed by UUID. */
  private readonly accessories = new Map<string, PlatformAccessory<TrimlightAccessoryContext>>();
  /** Active handlers, keyed by UUID. */
  private readonly handlers = new Map<string, TrimlightAccessory>();
  private readonly settings?: TrimlightPlatformConfig;
  private readonly client?: Client;
  private readonly timing: PlatformTiming;
  private pollTimer?: NodeJS.Timeout;
  private retryDelayMs: number;
  private stopped = false;
  private lastPollError?: string;
  /** Devices whose detail fetch is failing, so it's logged once per outage. */
  private readonly detailFailures = new Set<string>();
  /** Per-device on-demand refresh bookkeeping, keyed by UUID. */
  private readonly lastRefreshAt = new Map<string, number>();
  private readonly refreshing = new Map<string, Promise<void>>();

  constructor(
    readonly log: Logger,
    config: PlatformConfig,
    readonly api: API,
    clientFactory: (settings: TrimlightPlatformConfig) => Client = (settings) => new TrimlightClient({
      clientId: settings.clientId,
      clientSecret: settings.clientSecret,
      baseUrl: settings.baseUrl,
      debug: (message) => log.debug(message),
    }),
    timing: Partial<PlatformTiming> = {},
  ) {
    this.timing = {
      notifySettleMs: NOTIFY_SETTLE_MS,
      refreshMinIntervalMs: ON_DEMAND_REFRESH_MIN_INTERVAL_MS,
      clockTickMs: CLOCK_TICK_MS,
      retryInitialMs: POLL_RETRY_INITIAL_MS,
      ...timing,
    };
    this.retryDelayMs = this.timing.retryInitialMs;

    const parsed = parseConfig(config);
    if (Array.isArray(parsed)) {
      this.log.error(`Invalid configuration, plugin disabled: ${parsed.join('; ')}`);
      return;
    }
    this.settings = parsed;
    this.client = clientFactory(parsed);
    const requested = Number(config.pollingIntervalSeconds);
    if (requested > 0 && requested < MIN_POLLING_INTERVAL_SECONDS) {
      this.log.warn(`pollingIntervalSeconds ${requested} is below the minimum; using ${MIN_POLLING_INTERVAL_SECONDS}. `
        + 'Status is also refreshed whenever the Home app shows the accessory.');
    }

    this.api.on('didFinishLaunching', () => {
      void this.poll();
    });
    this.api.on('shutdown', () => this.stop());
  }

  /** Called by Homebridge for each accessory restored from its cache. */
  configureAccessory(accessory: PlatformAccessory): void {
    this.log.debug(`Restoring cached accessory: ${accessory.displayName}`);
    this.accessories.set(accessory.UUID, accessory as PlatformAccessory<TrimlightAccessoryContext>);
  }

  stop(): void {
    this.stopped = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
    for (const handler of this.handlers.values()) {
      handler.dispose();
    }
  }

  /** Full check: device list plus each device's status; schedules the next one. */
  async poll(): Promise<void> {
    if (this.stopped || !this.client || !this.settings) {
      return;
    }
    let failed = false;
    try {
      const devices = await this.client.listDevices();
      const states: DeviceState[] = [];
      for (const device of devices) {
        if (this.stopped) {
          return;
        }
        states.push(await this.fetchState(device));
      }
      this.syncAccessories(states);
      if (this.lastPollError) {
        this.log.info('Connection to the Trimlight cloud restored');
        this.lastPollError = undefined;
      }
    } catch (error) {
      failed = true;
      this.reportPollError(error as Error);
    } finally {
      this.scheduleNextPoll(failed);
    }
  }

  /**
   * Refreshes one device's status, e.g. because HomeKit just read it. Throttled
   * per device (unless `force`) and coalesced with a refresh already running.
   */
  refreshDevice(uuid: string, force = false): Promise<void> {
    const running = this.refreshing.get(uuid);
    if (running) {
      return running;
    }
    const now = Date.now();
    if (!force && now - (this.lastRefreshAt.get(uuid) ?? 0) < this.timing.refreshMinIntervalMs) {
      return Promise.resolve();
    }
    const accessory = this.accessories.get(uuid);
    const handler = this.handlers.get(uuid);
    if (this.stopped || !this.client || !accessory || !handler) {
      return Promise.resolve();
    }
    this.lastRefreshAt.set(uuid, now);

    const refresh = (async () => {
      try {
        const state = await this.readStatus(accessory.context.device);
        if (!this.stopped && this.handlers.get(uuid) === handler) {
          handler.update(state);
        }
      } catch (error) {
        this.reportPollError(error as Error);
      } finally {
        this.refreshing.delete(uuid);
      }
    })();
    this.refreshing.set(uuid, refresh);
    return refresh;
  }

  /**
   * The device list carries no switch state, so on/off (and the schedules
   * that decide it in timer mode) come from the device detail. Offline
   * controllers and failed fetches keep the last known values.
   */
  private async fetchState(device: TrimlightDevice): Promise<DeviceState> {
    const uuid = this.api.hap.uuid.generate(device.deviceId);
    const previous = this.accessories.get(uuid)?.context.device;
    const carried: DeviceState = {
      ...device,
      switchState: device.switchState ?? previous?.switchState,
      daily: previous?.daily,
      calendar: previous?.calendar,
    };
    if (device.connectivity !== 1) {
      return carried;
    }
    this.lastRefreshAt.set(uuid, Date.now());
    return this.readStatus(carried);
  }

  /**
   * Asks the controller to report in, gives it a moment, then reads the
   * detail. Reading immediately can return the state from before the latest
   * change. Credential errors propagate; other failures keep `base`.
   */
  private async readStatus(base: DeviceState): Promise<DeviceState> {
    const client = this.client!;
    await client.notifyUpdateShadow(base.deviceId);
    if (this.timing.notifySettleMs > 0) {
      await sleep(this.timing.notifySettleMs);
    }
    try {
      const detail = await client.getDeviceDetail(base.deviceId);
      if (this.detailFailures.delete(base.deviceId)) {
        this.log.info(`Status of ${base.name} is available again`);
      }
      return {
        ...base,
        switchState: typeof detail.switchState === 'number' ? detail.switchState : base.switchState,
        connectivity: typeof detail.connectivity === 'number' ? detail.connectivity : base.connectivity,
        daily: Array.isArray(detail.daily) ? detail.daily : base.daily,
        calendar: Array.isArray(detail.calendar) ? detail.calendar : base.calendar,
      };
    } catch (error) {
      if (error instanceof TrimlightAuthError) {
        throw error;
      }
      const message = `Unable to read the status of ${base.name}: ${(error as Error).message}`;
      if (this.detailFailures.has(base.deviceId)) {
        this.log.debug(message);
      } else {
        this.detailFailures.add(base.deviceId);
        this.log.warn(`${message} (keeping the last known state)`);
      }
      return base;
    }
  }

  /**
   * After a failure, retries sooner (30 s doubling up to the interval, or up
   * to 15 min when background checks are off) so a network hiccup at startup
   * doesn't leave accessories stale for long.
   */
  private scheduleNextPoll(failed: boolean): void {
    if (this.stopped || !this.settings) {
      return;
    }
    const intervalMs = this.settings.pollingIntervalSeconds * 1000;
    let delay: number;
    if (failed) {
      const cap = intervalMs || DEFAULT_POLLING_INTERVAL_SECONDS * 1000;
      delay = Math.min(this.retryDelayMs, cap);
      this.retryDelayMs = Math.min(this.retryDelayMs * 2, cap);
    } else {
      this.retryDelayMs = this.timing.retryInitialMs;
      if (!intervalMs) {
        return;
      }
      delay = intervalMs;
    }
    this.pollTimer = setTimeout(() => void this.poll(), delay);
    // Don't keep the process alive just for polling.
    this.pollTimer.unref?.();
  }

  private reportPollError(error: Error): void {
    const message = error.message;
    if (message === this.lastPollError) {
      this.log.debug(`Still unable to reach the Trimlight cloud: ${message}`);
      return;
    }
    this.lastPollError = message;
    if (error instanceof TrimlightAuthError) {
      this.log.error(`Trimlight rejected the API credentials: ${message}`);
    } else {
      this.log.warn(`Unable to refresh Trimlight devices (will keep retrying): ${message}`);
    }
  }

  private syncAccessories(devices: DeviceState[]): void {
    const seen = new Set<string>();

    for (const device of devices) {
      const uuid = this.api.hap.uuid.generate(device.deviceId);
      seen.add(uuid);

      const handler = this.handlers.get(uuid);
      if (handler) {
        handler.update(device);
        continue;
      }

      const cached = this.accessories.get(uuid);
      if (cached) {
        this.log.info(`Restored ${cached.displayName} (${device.deviceId})`);
        cached.context.device = device;
        this.handlers.set(uuid, this.createHandler(cached));
        this.api.updatePlatformAccessories([cached]);
        continue;
      }

      const name = sanitizeName(device.name);
      this.log.info(`Adding ${name} (${device.deviceId})`);
      const accessory = new this.api.platformAccessory<TrimlightAccessoryContext>(name, uuid);
      accessory.context.device = device;
      this.accessories.set(uuid, accessory);
      this.handlers.set(uuid, this.createHandler(accessory));
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }

    const stale = [...this.accessories.values()].filter((accessory) => !seen.has(accessory.UUID));
    if (!stale.length) {
      return;
    }
    if (!devices.length) {
      // An empty list is more likely an API hiccup than every controller
      // being removed; don't wipe the user's Home setup over it.
      this.log.warn('Trimlight returned no devices; keeping existing accessories');
      return;
    }
    for (const accessory of stale) {
      this.log.info(`Removing ${accessory.displayName}: no longer on the Trimlight account`);
      this.handlers.get(accessory.UUID)?.dispose();
      this.accessories.delete(accessory.UUID);
      this.handlers.delete(accessory.UUID);
    }
    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
  }

  private createHandler(accessory: PlatformAccessory<TrimlightAccessoryContext>): TrimlightAccessory {
    return new TrimlightAccessory({
      api: this.api,
      log: this.log,
      client: this.client!,
      exposeAs: this.settings!.exposeAs,
      requestRefresh: (force) => this.refreshDevice(accessory.UUID, force),
      clockTickMs: this.timing.clockTickMs,
    }, accessory);
  }
}
