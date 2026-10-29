import type { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig } from 'homebridge';

import {
  DEFAULT_POLLING_INTERVAL_SECONDS,
  MIN_POLLING_INTERVAL_SECONDS,
  PLATFORM_NAME,
  PLUGIN_NAME,
} from './settings';
import { ExposeAs, sanitizeName, TrimlightAccessory, TrimlightAccessoryContext } from './trimlightAccessory';
import { TrimlightAuthError, TrimlightClient, TrimlightDevice } from './trimlightApi';

export interface TrimlightPlatformConfig {
  clientId: string;
  clientSecret: string;
  pollingIntervalSeconds: number;
  exposeAs: ExposeAs;
  /** Undocumented; lets tests point the plugin at a mock server. */
  baseUrl?: string;
}

type Client = Pick<TrimlightClient, 'listDevices' | 'setSwitchState' | 'notifyUpdateShadow'>;

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
    if (!Number.isFinite(parsed) || parsed < MIN_POLLING_INTERVAL_SECONDS) {
      errors.push(`"pollingIntervalSeconds" must be a number >= ${MIN_POLLING_INTERVAL_SECONDS}`);
    } else {
      pollingIntervalSeconds = parsed;
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

export class TrimlightPlatform implements DynamicPlatformPlugin {
  /** Accessories restored from the Homebridge cache, keyed by UUID. */
  private readonly accessories = new Map<string, PlatformAccessory<TrimlightAccessoryContext>>();
  /** Active handlers, keyed by UUID. */
  private readonly handlers = new Map<string, TrimlightAccessory>();
  private readonly settings?: TrimlightPlatformConfig;
  private readonly client?: Client;
  private pollTimer?: NodeJS.Timeout;
  private stopped = false;
  private lastPollError?: string;

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
  ) {
    const parsed = parseConfig(config);
    if (Array.isArray(parsed)) {
      this.log.error(`Invalid configuration, plugin disabled: ${parsed.join('; ')}`);
      return;
    }
    this.settings = parsed;
    this.client = clientFactory(parsed);

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
  }

  /** Fetches device state once, syncs accessories, and schedules the next poll. */
  async poll(): Promise<void> {
    if (this.stopped || !this.client || !this.settings) {
      return;
    }
    try {
      const devices = await this.client.listDevices();
      this.syncAccessories(devices);
      if (this.lastPollError) {
        this.log.info('Connection to the Trimlight cloud restored');
        this.lastPollError = undefined;
      }
      // Ask online controllers to report fresh state for the next poll.
      for (const device of devices) {
        if (device.connectivity === 1 && !this.stopped) {
          await this.client.notifyUpdateShadow(device.deviceId);
        }
      }
    } catch (error) {
      this.reportPollError(error as Error);
    } finally {
      this.scheduleNextPoll();
    }
  }

  private scheduleNextPoll(): void {
    if (this.stopped || !this.settings) {
      return;
    }
    this.pollTimer = setTimeout(() => void this.poll(), this.settings.pollingIntervalSeconds * 1000);
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

  private syncAccessories(devices: TrimlightDevice[]): void {
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
    }, accessory);
  }
}
