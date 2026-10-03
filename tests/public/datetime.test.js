const path = require('path');

require(path.join(__dirname, '../../public/js/datetime.js'));

describe('display timezone', () => {
  const previous = global.settings;

  afterEach(() => {
    global.settings = previous;
  });

  function useOffset(hours) {
    global.settings = {
      get: (key) => (key === 'timezoneOffset' ? String(hours) : undefined),
    };
  }

  test('treats timezone-less timestamps as UTC', () => {
    expect(parseAppDate('2026-10-03 10:34:00').toISOString()).toBe('2026-10-03T10:34:00.000Z');
    expect(parseAppDate('2026-10-03T10:34:00').toISOString()).toBe('2026-10-03T10:34:00.000Z');
  });

  test('keeps timestamps that already carry a zone', () => {
    expect(parseAppDate('2026-10-03T10:34:00.000Z').toISOString()).toBe('2026-10-03T10:34:00.000Z');
    expect(parseAppDate('2026-10-03T13:34:00+03:00').toISOString()).toBe('2026-10-03T10:34:00.000Z');
  });

  test('shifts a UTC chat timestamp to GMT+3', () => {
    useOffset(3);
    expect(appZonedParts('2026-10-03 10:34:00')).toEqual({
      year: 2026, month: 10, day: 3, hour: 13, minute: 34, second: 0,
    });
    expect(appTimezoneLabel()).toBe('GMT+3');
  });

  test('GMT+0 shows the stored UTC clock', () => {
    useOffset(0);
    expect(appZonedParts('2026-10-03 10:34:00').hour).toBe(10);
    expect(appTimezoneLabel()).toBe('GMT+0');
  });

  test('a negative offset moves the clock backward and can change the date', () => {
    useOffset(-5);
    expect(appZonedParts('2026-10-03 02:15:00')).toEqual({
      year: 2026, month: 10, day: 2, hour: 21, minute: 15, second: 0,
    });
    expect(formatGmtLabel(-330)).toBe('GMT-5:30');
  });

  test('automatic follows this computer', () => {
    global.settings = { get: () => 'auto' };
    expect(getAppTimezoneOffsetMinutes()).toBe(-new Date().getTimezoneOffset());
  });

  test('formatAppTime is non-empty for a real timestamp', () => {
    useOffset(3);
    const text = formatAppTime('2026-10-03 10:34:00', {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    expect(text).toMatch(/13/);
    expect(text).toMatch(/34/);
  });
});
