import { DailySchedule, inWindow, isScheduleLit } from '../src/schedule';

const at = (h: number, m: number, base = new Date(2026, 9, 28)) => {
  const d = new Date(base.getTime());
  d.setHours(h, m, 0, 0);
  return d;
};
// 2026-10-28 is a Wednesday; 2026-10-31 a Saturday; 2026-11-01 a Sunday.
const WEDNESDAY = new Date(2026, 9, 28);
const SATURDAY = new Date(2026, 9, 31);
const SUNDAY = new Date(2026, 10, 1);
const MONDAY = new Date(2026, 10, 2);

const daily = (start: [number, number], end: [number, number], extra: Partial<DailySchedule> = {}): DailySchedule => ({
  enable: true,
  repetition: 1,
  startTime: { hours: start[0], minutes: start[1] },
  endTime: { hours: end[0], minutes: end[1] },
  ...extra,
});

describe('inWindow', () => {
  it('handles same-day and midnight-wrapping windows with an exclusive end', () => {
    expect(inWindow(18 * 60, { start: 18 * 60, end: 21 * 60 })).toBe(true);
    expect(inWindow(21 * 60, { start: 18 * 60, end: 21 * 60 })).toBe(false);
    expect(inWindow(23 * 60, { start: 22 * 60, end: 2 * 60 })).toBe(true);
    expect(inWindow(60, { start: 22 * 60, end: 2 * 60 })).toBe(true);
    expect(inWindow(12 * 60, { start: 22 * 60, end: 2 * 60 })).toBe(false);
    expect(inWindow(0, { start: 5, end: 5 })).toBe(false);
  });
});

describe('isScheduleLit', () => {
  // The schedule from the user's real controller (captured 2026-10-28).
  const realSchedule = {
    daily: [
      daily([18, 0], [21, 0], { id: 0, effectId: 7, repetition: 1 }),
      daily([0, 2], [0, 3], { id: 1, enable: false, effectId: 1, repetition: 0 }),
    ],
    calendar: [],
  };

  it('is lit inside the real 18:00-21:00 every-day window and dark outside it', () => {
    expect(isScheduleLit(realSchedule, at(12, 0))).toBe(false);
    expect(isScheduleLit(realSchedule, at(17, 59))).toBe(false);
    expect(isScheduleLit(realSchedule, at(18, 0))).toBe(true);
    expect(isScheduleLit(realSchedule, at(20, 59))).toBe(true);
    expect(isScheduleLit(realSchedule, at(21, 0))).toBe(false);
  });

  it('ignores disabled entries (the disabled 00:02-00:03 entry never lights)', () => {
    expect(isScheduleLit(realSchedule, at(0, 2))).toBe(false);
  });

  it('is undetermined when there are no usable windows', () => {
    expect(isScheduleLit({ daily: [], calendar: [] }, at(12, 0))).toBeUndefined();
    expect(isScheduleLit({}, at(12, 0))).toBeUndefined();
    expect(isScheduleLit({ daily: [daily([1, 0], [1, 0])] }, at(1, 0))).toBeUndefined();
    expect(isScheduleLit({ daily: [{ enable: true, startTime: { hours: 25, minutes: 0 }, endTime: { hours: 1, minutes: 0 } }] }, at(1, 0)))
      .toBeUndefined();
    expect(isScheduleLit({ daily: 'garbage', calendar: [null, 5] }, at(1, 0))).toBeUndefined();
  });

  it('is lit if any of several windows is active', () => {
    const s = { daily: [daily([6, 0], [8, 0]), daily([18, 0], [21, 0])] };
    expect(isScheduleLit(s, at(7, 0))).toBe(true);
    expect(isScheduleLit(s, at(19, 0))).toBe(true);
    expect(isScheduleLit(s, at(12, 0))).toBe(false);
  });

  it('honors weekday and weekend repetition', () => {
    const weekdays = { daily: [daily([18, 0], [21, 0], { repetition: 2 })] };
    const weekend = { daily: [daily([18, 0], [21, 0], { repetition: 3 })] };
    expect(isScheduleLit(weekdays, at(19, 0, WEDNESDAY))).toBe(true);
    expect(isScheduleLit(weekdays, at(19, 0, SATURDAY))).toBe(false);
    expect(isScheduleLit(weekend, at(19, 0, SATURDAY))).toBe(true);
    expect(isScheduleLit(weekend, at(19, 0, WEDNESDAY))).toBe(false);
  });

  it('attributes the after-midnight part of a wrapping window to the day it started', () => {
    const weekend = { daily: [daily([22, 0], [2, 0], { repetition: 3 })] };
    // Saturday 23:00 and Sunday 01:00 (started Saturday) are lit.
    expect(isScheduleLit(weekend, at(23, 0, SATURDAY))).toBe(true);
    expect(isScheduleLit(weekend, at(1, 0, SUNDAY))).toBe(true);
    // Monday 01:00 belongs to Sunday night's run, which does apply.
    expect(isScheduleLit(weekend, at(1, 0, MONDAY))).toBe(true);
    // Wednesday 01:00 belongs to Tuesday's run, which doesn't: no opinion.
    expect(isScheduleLit(weekend, at(1, 0, WEDNESDAY))).toBeUndefined();
    // Outside the window entirely is positively dark.
    expect(isScheduleLit(weekend, at(12, 0, SATURDAY))).toBe(false);
  });

  it('honors calendar date ranges, including ones that wrap the year end', () => {
    const halloween = {
      calendar: [{ startDate: { month: 10, day: 25 }, endDate: { month: 10, day: 31 }, startTime: { hours: 18, minutes: 0 }, endTime: { hours: 23, minutes: 0 } }],
    };
    expect(isScheduleLit(halloween, at(19, 0, WEDNESDAY))).toBe(true);
    expect(isScheduleLit(halloween, at(19, 0, new Date(2026, 10, 5)))).toBe(false);

    const newYear = {
      calendar: [{ startDate: { month: 12, day: 31 }, endDate: { month: 1, day: 1 }, startTime: { hours: 18, minutes: 0 }, endTime: { hours: 23, minutes: 0 } }],
    };
    expect(isScheduleLit(newYear, at(19, 0, new Date(2026, 11, 31)))).toBe(true);
    expect(isScheduleLit(newYear, at(19, 0, new Date(2027, 0, 1)))).toBe(true);
    expect(isScheduleLit(newYear, at(19, 0, new Date(2027, 0, 2)))).toBe(false);
  });

  it('ignores calendar entries without valid dates or that are disabled', () => {
    const s = {
      calendar: [
        { startTime: { hours: 18, minutes: 0 }, endTime: { hours: 23, minutes: 0 } },
        { enable: false, startDate: { month: 1, day: 1 }, endDate: { month: 12, day: 31 }, startTime: { hours: 0, minutes: 0 }, endTime: { hours: 23, minutes: 59 } },
      ],
    };
    expect(isScheduleLit(s, at(19, 0))).toBe(false);
  });
});
