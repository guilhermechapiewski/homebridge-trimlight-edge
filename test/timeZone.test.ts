import { hostTimeZone, isUtcZone, isValidTimeZone, wallClock } from '../src/timeZone';

const fields = (d: Date) => [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getDay(), d.getHours(), d.getMinutes(), d.getSeconds()];

describe('wallClock', () => {
  // 2026-10-29 03:20:21 UTC = 2026-10-28 20:20:21 in Los Angeles (PDT, UTC-7), a Wednesday.
  const instant = new Date(Date.UTC(2026, 9, 29, 3, 20, 21));

  it('reads the wall clock of the given zone, whatever the host zone', () => {
    expect(fields(wallClock(instant, 'America/Los_Angeles'))).toEqual([2026, 10, 28, 3, 20, 20, 21]);
    expect(fields(wallClock(instant, 'UTC'))).toEqual([2026, 10, 29, 4, 3, 20, 21]);
    expect(fields(wallClock(instant, 'Asia/Kolkata'))).toEqual([2026, 10, 29, 4, 8, 50, 21]);
  });

  it('follows daylight saving in the target zone', () => {
    // 2026-11-01 is the US fall-back date: 09:00 UTC is 01:00 PST (UTC-8).
    expect(wallClock(new Date(Date.UTC(2026, 10, 1, 9, 0)), 'America/Los_Angeles').getHours()).toBe(1);
    // Summer: 19:00 UTC is 12:00 PDT.
    expect(wallClock(new Date(Date.UTC(2026, 6, 1, 19, 0)), 'America/Los_Angeles').getHours()).toBe(12);
  });

  it('returns the date unchanged without a zone', () => {
    expect(wallClock(instant)).toBe(instant);
  });

  it('handles midnight (some ICU versions format it as hour 24)', () => {
    expect(wallClock(new Date(Date.UTC(2026, 9, 29, 7, 0)), 'America/Los_Angeles').getHours()).toBe(0);
  });
});

describe('time zone helpers', () => {
  it('validates IANA zone names', () => {
    expect(isValidTimeZone('America/Los_Angeles')).toBe(true);
    expect(isValidTimeZone('Europe/Lisbon')).toBe(true);
    expect(isValidTimeZone('Pacific Time')).toBe(false);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
  });

  it('recognizes UTC names', () => {
    for (const zone of ['UTC', 'Etc/UTC', 'GMT', 'Etc/GMT', 'Etc/Universal', 'Zulu']) {
      expect(isUtcZone(zone)).toBe(true);
    }
    expect(isUtcZone('America/Los_Angeles')).toBe(false);
    expect(isUtcZone('Europe/London')).toBe(false);
  });

  it('reports the host zone', () => {
    expect(isValidTimeZone(hostTimeZone())).toBe(true);
  });
});
