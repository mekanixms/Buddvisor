const { computeNextRunAt } = require('../../src/services/scheduler/SchedulerService');

describe('computeNextRunAt', () => {
  it('uses the cron expression instead of adding one hour', () => {
    const after = new Date(2026, 9, 2, 12, 0, 0);
    const next = new Date(computeNextRunAt(
      { id: 14, schedule_type: 'cron', schedule_value: '30 21 * * *' },
      after.toISOString()
    ));
    expect(next.getFullYear()).toBe(2026);
    expect(next.getMonth()).toBe(9);
    expect(next.getDate()).toBe(2);
    expect(next.getHours()).toBe(21);
    expect(next.getMinutes()).toBe(30);
    expect(next.getSeconds()).toBe(0);
  });

  it('advances a cron that just fired to the following occurrence', () => {
    const after = new Date(2026, 9, 2, 21, 30, 0);
    const next = new Date(computeNextRunAt(
      { id: 14, schedule_type: 'cron', schedule_value: '30 21 * * *' },
      after.toISOString()
    ));
    expect(next.getDate()).toBe(3);
    expect(next.getHours()).toBe(21);
    expect(next.getMinutes()).toBe(30);
  });

  it('keeps an interval schedule in seconds', () => {
    const after = new Date('2026-10-02T08:00:00.000Z');
    const next = computeNextRunAt(
      { schedule_type: 'interval', schedule_value: '90', last_run_at: null, created_at: null },
      after.toISOString()
    );
    expect(next).toBe(new Date(after.getTime() + 90 * 1000).toISOString());
  });

  it('falls back to one hour when the cron expression is invalid', () => {
    const after = new Date('2026-10-02T08:54:04.358Z');
    const next = computeNextRunAt(
      { id: 14, schedule_type: 'cron', schedule_value: 'not a cron' },
      after.toISOString()
    );
    expect(next).toBe(new Date(after.getTime() + 60 * 60 * 1000).toISOString());
  });
});
