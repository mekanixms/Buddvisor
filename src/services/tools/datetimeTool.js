/**
 * Datetime tool — current date/time without web_search or workspace_exec.
 */

const { toolRegistry } = require('./ToolRegistry');
const { snapshotDateTime } = require('../../utils/datetimeFormat');
const logger = require('../../utils/logger');

function registerDatetimeTool() {
  toolRegistry.register({
    name: 'datetime',
    description:
      'Get the current date and time. Optional format tokens: YYYY YY MM DD HH mm ss dddd ddd tz. Optional IANA timezone (e.g. Europe/Bucharest, UTC). Use this instead of web_search or workspace_exec for "what time is it" / "what is today\'s date".',
    category: 'utility',
    parameters: {
      format: {
        type: 'string',
        description:
          'Optional output format. Examples: "YYYY-MM-DD HH:mm:ss", "YYDDMM-HH:mm". If omitted, returns ISO-8601 with offset.',
        required: false,
        maxLength: 80,
      },
      timezone: {
        type: 'string',
        description:
          'IANA timezone such as Europe/Bucharest, America/New_York, or UTC. Defaults to the server timezone.',
        required: false,
        maxLength: 64,
      },
    },
    handler: async (params) => {
      const format = params?.format ? String(params.format) : null;
      const timezone = params?.timezone ? String(params.timezone).trim() : null;
      const snap = snapshotDateTime({ format, timeZone: timezone });
      const result = {
        iso: snap.iso,
        formatted: snap.formatted,
        date: snap.date,
        time: snap.time,
        weekday: snap.weekday,
        unix: snap.unix,
        timezone: snap.timezone,
        year: snap.year,
        month: snap.month,
        day: snap.day,
      };
      if (timezone && !snap.timezone_valid) {
        result.warning = `Unrecognized timezone "${timezone}"; used ${snap.timezone} instead.`;
      }
      logger.debug(`datetime tool: iso=${result.iso} tz=${result.timezone}`);
      return result;
    },
    examples: [
      { description: 'Current time (ISO)', parameters: {} },
      { description: 'Compact stamp', parameters: { format: 'YYDDMM-HH:mm' } },
      {
        description: 'Local wall time in Bucharest',
        parameters: { format: 'YYYY-MM-DD HH:mm:ss', timezone: 'Europe/Bucharest' },
      },
    ],
  });

  logger.info('datetime tool registered');
}

module.exports = { registerDatetimeTool };
