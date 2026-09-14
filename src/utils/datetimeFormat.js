/**
 * Shared date/time formatting for the datetime tool and system-prompt macros.
 */

const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function pad(n, width = 2) {
  return String(n).padStart(width, '0');
}

function defaultTimeZone() {
  return process.env.APP_TIMEZONE || process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function normalizeTimeZone(timeZone) {
  const raw = String(timeZone || '').trim();
  if (!raw || /^local$/i.test(raw)) return defaultTimeZone();
  if (/^(UTC|GMT)$/i.test(raw)) return 'UTC';
  return raw;
}

function isValidTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/**
 * Calendar parts in a given IANA timezone.
 */
function getZonedParts(date, timeZone) {
  const tz = normalizeTimeZone(timeZone);
  const resolvedTz = isValidTimeZone(tz) ? tz : defaultTimeZone();
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: resolvedTz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  });
  const map = {};
  for (const part of fmt.formatToParts(date)) {
    if (part.type !== 'literal') map[part.type] = part.value;
  }
  let hour = parseInt(map.hour, 10);
  if (Number.isNaN(hour)) hour = 0;
  if (hour === 24) hour = 0;
  const year = String(map.year || date.getUTCFullYear());
  const month = pad(parseInt(map.month, 10) || 1);
  const day = pad(parseInt(map.day, 10) || 1);
  const minute = pad(parseInt(map.minute, 10) || 0);
  const second = pad(parseInt(map.second, 10) || 0);
  const weekdayShort = map.weekday || WEEKDAYS_SHORT[date.getUTCDay()];
  const weekdayIdx = WEEKDAYS_SHORT.indexOf(weekdayShort);
  const weekdayLong = weekdayIdx >= 0 ? WEEKDAYS_LONG[weekdayIdx] : weekdayShort;
  return {
    year,
    month,
    day,
    hour: pad(hour),
    minute,
    second,
    weekdayShort,
    weekdayLong,
    timeZone: resolvedTz,
    timeZoneValid: isValidTimeZone(tz),
    requestedTimeZone: tz,
  };
}

function isoOffsetForTimeZone(date, timeZone) {
  const parts = getZonedParts(date, timeZone);
  const asUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  const offsetMin = Math.round((asUTC - date.getTime()) / 60000);
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function toIsoString(date, timeZone) {
  const p = getZonedParts(date, timeZone);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${isoOffsetForTimeZone(date, p.timeZone)}`;
}

/**
 * Format tokens: YYYY YY MM DD HH mm ss dddd ddd tz
 * Example: "YYDDMM-HH:mm" → "261409-20:49"
 */
function formatDateTime(date, format, timeZone) {
  const p = getZonedParts(date, timeZone);
  if (!format || !String(format).trim()) {
    return { formatted: toIsoString(date, p.timeZone), parts: p };
  }
  const formatted = String(format)
    .replace(/YYYY/g, p.year)
    .replace(/dddd/g, p.weekdayLong)
    .replace(/ddd/g, p.weekdayShort)
    .replace(/YY/g, p.year.slice(-2))
    .replace(/MM/g, p.month)
    .replace(/DD/g, p.day)
    .replace(/HH/g, p.hour)
    .replace(/mm/g, p.minute)
    .replace(/ss/g, p.second)
    .replace(/tz/g, p.timeZone);
  return { formatted, parts: p };
}

function snapshotDateTime(options = {}) {
  const date = options.now instanceof Date ? options.now : new Date();
  const timeZone = options.timeZone;
  const { formatted, parts } = formatDateTime(date, options.format, timeZone);
  return {
    iso: toIsoString(date, parts.timeZone),
    unix: Math.floor(date.getTime() / 1000),
    formatted,
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}:${parts.second}`,
    year: parts.year,
    month: parts.month,
    day: parts.day,
    weekday: parts.weekdayLong,
    timezone: parts.timeZone,
    timezone_valid: parts.timeZoneValid,
    requested_timezone: parts.requestedTimeZone,
  };
}

module.exports = {
  defaultTimeZone,
  normalizeTimeZone,
  isValidTimeZone,
  getZonedParts,
  formatDateTime,
  toIsoString,
  snapshotDateTime,
};
