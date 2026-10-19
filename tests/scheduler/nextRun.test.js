const { computeNextRunAt, nextRunWhenEnabling } = require('../../src/services/scheduler/SchedulerService');

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

describe('nextRunWhenEnabling', () => {
  const now = new Date(2026, 9, 19, 8, 0, 0);

  it('keeps a next run that is still in the future', () => {
    const future = new Date(2026, 9, 19, 21, 30, 0).toISOString();
    expect(nextRunWhenEnabling({
      schedule_type: 'cron',
      schedule_value: '30 21 * * *',
      next_run_at: future,
    }, now)).toBe(future);
  });

  it('moves an overdue cron to the next occurrence after now', () => {
    const next = new Date(nextRunWhenEnabling({
      id: 3,
      schedule_type: 'cron',
      schedule_value: '30 21 * * *',
      next_run_at: new Date(2026, 9, 1, 21, 30, 0).toISOString(),
    }, now));
    expect(next.getTime()).toBeGreaterThan(now.getTime());
    expect(next.getHours()).toBe(21);
    expect(next.getMinutes()).toBe(30);
    expect(next.getDate()).toBe(19);
  });

  it('schedules an overdue interval one period from now', () => {
    const next = nextRunWhenEnabling({
      schedule_type: 'interval',
      schedule_value: '90',
      last_run_at: new Date(2026, 9, 1, 8, 0, 0).toISOString(),
      next_run_at: new Date(2026, 9, 1, 8, 1, 30).toISOString(),
    }, now);
    expect(next).toBe(new Date(now.getTime() + 90 * 1000).toISOString());
  });
});
