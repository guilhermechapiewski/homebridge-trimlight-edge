/**
 * Works out whether a controller in timer mode currently has its lights lit.
 *
 * In timer mode the cloud keeps reporting `switchState: 2` whether or not the
 * schedule is lighting anything right now, so the running state has to be
 * derived from the daily and calendar schedule windows.
 *
 * Ported from the MIT-licensed Home Assistant integration
 * https://github.com/Michael-Civitillo/trimlight-edge-ha (light.py), which
 * worked these rules out against real controllers.
 */

export interface ScheduleTime {
  hours?: number;
  minutes?: number;
}

export interface ScheduleDate {
  month?: number;
  day?: number;
}

export interface DailySchedule {
  id?: number;
  enable?: boolean;
  effectId?: number;
  /** 0: today only, 1: every day, 2: weekdays, 3: weekend. */
  repetition?: number;
  startTime?: ScheduleTime;
  endTime?: ScheduleTime;
}

export interface CalendarSchedule {
  id?: number;
  enable?: boolean;
  effectId?: number;
  startDate?: ScheduleDate;
  endDate?: ScheduleDate;
  startTime?: ScheduleTime;
  endTime?: ScheduleTime;
}

export const REPETITION_WEEKDAYS = 2;
export const REPETITION_WEEKEND = 3;

type Window = { start: number; end: number };
type Entry = DailySchedule | CalendarSchedule;
type AppliesOn = (entry: Entry, date: Date) => boolean;

function toMinutes(time: unknown): number | undefined {
  if (typeof time !== 'object' || time === null) {
    return undefined;
  }
  const { hours, minutes } = time as ScheduleTime;
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) {
    return undefined;
  }
  if (hours! < 0 || hours! > 23 || minutes! < 0 || minutes! > 59) {
    return undefined;
  }
  return hours! * 60 + minutes!;
}

/**
 * A zero-length window could mean "off" or "all day", so it is treated as
 * unusable rather than guessed at.
 */
function windowOf(entry: Entry): Window | undefined {
  const start = toMinutes(entry.startTime);
  const end = toMinutes(entry.endTime);
  if (start === undefined || end === undefined || start === end) {
    return undefined;
  }
  return { start, end };
}

/** [start, end) membership, handling windows that wrap past midnight. */
export function inWindow(nowMinutes: number, { start, end }: Window): boolean {
  if (start === end) {
    return false;
  }
  return start < end
    ? nowMinutes >= start && nowMinutes < end
    : nowMinutes >= start || nowMinutes < end;
}

/**
 * Only day sets that can be identified positively (weekdays/weekend) are
 * excluded; "every day", "today only" and unknown values count as applying so
 * a lit light is never reported as off.
 */
const dailyAppliesOn: AppliesOn = (entry, date) => {
  const weekend = date.getDay() === 0 || date.getDay() === 6;
  switch ((entry as DailySchedule).repetition) {
    case REPETITION_WEEKDAYS:
      return !weekend;
    case REPETITION_WEEKEND:
      return weekend;
    default:
      return true;
  }
};

const calendarAppliesOn: AppliesOn = (entry, date) => {
  const { startDate, endDate } = entry as CalendarSchedule;
  if (!Number.isInteger(startDate?.month) || !Number.isInteger(startDate?.day)
    || !Number.isInteger(endDate?.month) || !Number.isInteger(endDate?.day)) {
    return false;
  }
  // Compare month/day as a single number, e.g. Dec 31 -> 1231.
  const start = startDate!.month! * 100 + startDate!.day!;
  const end = endDate!.month! * 100 + endDate!.day!;
  const today = (date.getMonth() + 1) * 100 + date.getDate();
  return start <= end
    ? today >= start && today <= end
    // Range wraps the year end (e.g. Dec 31 -> Jan 1).
    : today >= start || today <= end;
};

/**
 * Votes on whether one entry has the lights on right now: true (lit), false
 * (positively not lit) or undefined (no opinion: disabled, unusable window, or
 * a midnight-wrapping window whose day attribution is uncertain).
 */
function vote(entry: Entry, now: Date, appliesOn: AppliesOn): boolean | undefined {
  if (entry.enable === false) {
    return undefined;
  }
  const window = windowOf(entry);
  if (!window) {
    return undefined;
  }
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const inside = inWindow(nowMinutes, window);

  if (window.start < window.end) {
    return inside && appliesOn(entry, now);
  }

  // Wraps midnight: the part after `start` belongs to today's run, the part
  // before `end` to the run that started yesterday.
  if (inside) {
    const yesterday = new Date(now.getTime());
    yesterday.setDate(yesterday.getDate() - 1);
    const runDay = nowMinutes >= window.start ? now : yesterday;
    return appliesOn(entry, runDay) ? true : undefined;
  }
  return false;
}

/**
 * Returns true/false when the schedules positively determine the state, or
 * undefined when there is no usable window (callers should then assume on).
 * Daily and calendar entries are additive: lit if inside any of them.
 */
export function isScheduleLit(
  schedules: { daily?: unknown; calendar?: unknown },
  now: Date,
): boolean | undefined {
  let decided = false;
  const sources: [unknown, AppliesOn][] = [
    [schedules.daily, dailyAppliesOn],
    [schedules.calendar, calendarAppliesOn],
  ];
  for (const [entries, appliesOn] of sources) {
    if (!Array.isArray(entries)) {
      continue;
    }
    for (const entry of entries) {
      if (typeof entry !== 'object' || entry === null) {
        continue;
      }
      const result = vote(entry as Entry, now, appliesOn);
      if (result === true) {
        return true;
      }
      if (result === false) {
        decided = true;
      }
    }
  }
  return decided ? false : undefined;
}
