/**
 * Name users reference in the Homebridge config.json `platform` field.
 * Must match `pluginAlias` in config.schema.json.
 */
export const PLATFORM_NAME = 'TrimlightEdge';

/** Must match the `name` in package.json. */
export const PLUGIN_NAME = 'homebridge-trimlight-edge';

/** Background check (device list + status). 0 turns it off. */
export const DEFAULT_POLLING_INTERVAL_SECONDS = 900;
export const MIN_POLLING_INTERVAL_SECONDS = 60;

/** Status refreshes triggered by Home reading the accessory are at most this frequent. */
export const ON_DEMAND_REFRESH_MIN_INTERVAL_MS = 15_000;

/** Wait between asking a controller to report in and reading its status. */
export const NOTIFY_SETTLE_MS = 2_000;

/** How often accessories re-evaluate their schedules locally (no API calls). */
export const CLOCK_TICK_MS = 60_000;

/** Retry delays after a failed background check, doubling up to the interval. */
export const POLL_RETRY_INITIAL_MS = 30_000;
