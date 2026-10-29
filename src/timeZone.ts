/**
 * Time zone handling. Schedules and the `currentDate` sent to Trimlight are
 * wall-clock times in the house's time zone, which is often not the time zone
 * of the Homebridge host (HOOBS boxes typically run on UTC).
 */

/** True if `timeZone` is an IANA zone this Node runtime knows. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** The host's time zone name, e.g. "Etc/UTC" or "America/Los_Angeles". */
export function hostTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** Whether a zone name means plain UTC. */
export function isUtcZone(timeZone: string): boolean {
  return /^(Etc\/)?(UTC|UCT|GMT|Universal|Zulu|GMT[+-]?0)$/i.test(timeZone);
}

/**
 * Where wall-clock time comes from: an IANA zone name, or a fixed offset from
 * UTC in minutes (e.g. -420 for UTC-07:00, learned from the controller's clock).
 * Undefined means the host's local time.
 */
export type Zone = string | number;

/** Formats an offset in minutes as "UTC-07:00". */
export function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/**
 * Returns a Date whose *local* getters (getHours, getDay, ...) read the wall
 * clock of `zone` at the instant `date`. With no zone, returns `date`
 * unchanged (host local time).
 *
 * The result is only meant for reading calendar fields. If the host itself
 * observes daylight saving and the wall time falls in the host's DST gap, it
 * can be off by an hour; UTC hosts (the usual case) are exact.
 */
export function wallClock(date: Date, zone?: Zone): Date {
  if (zone === undefined || zone === '') {
    return date;
  }
  if (typeof zone === 'number') {
    const shifted = new Date(date.getTime() + zone * 60_000);
    return new Date(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(),
      shifted.getUTCHours(), shifted.getUTCMinutes(), shifted.getUTCSeconds(), shifted.getUTCMilliseconds());
  }
  const timeZone = zone;
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, formatter);
  }
  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') {
      parts[part.type] = Number(part.value);
    }
  }
  return new Date(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second, date.getMilliseconds());
}
