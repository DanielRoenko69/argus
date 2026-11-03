import { assertAuditReportTimezone, nextAuditReportRun } from '../reportSchedule.js';

describe('audit report scheduling', () => {
  test('calculates the next daily wall-clock run in the configured timezone', () => {
    const next = nextAuditReportRun({ cadence: 'daily', timezone: 'Europe/Berlin', scheduleHour: 8, scheduleWeekday: null, scheduleMonthday: null }, new Date('2026-07-10T07:00:00.000Z'));
    expect(next?.toISOString()).toBe('2026-07-11T06:00:00.000Z');
  });

  test('respects weekly and monthly schedule shapes', () => {
    expect(nextAuditReportRun({ cadence: 'weekly', timezone: 'UTC', scheduleHour: 8, scheduleWeekday: 1, scheduleMonthday: null }, new Date('2026-07-10T00:00:00.000Z'))?.toISOString()).toBe('2026-07-13T08:00:00.000Z');
    expect(nextAuditReportRun({ cadence: 'monthly', timezone: 'UTC', scheduleHour: 8, scheduleWeekday: null, scheduleMonthday: 1 }, new Date('2026-07-10T00:00:00.000Z'))?.toISOString()).toBe('2026-08-01T08:00:00.000Z');
  });

  test('manual definitions have no scheduled run and invalid zones fail closed', () => {
    expect(nextAuditReportRun({ cadence: 'manual', timezone: 'UTC', scheduleHour: 8, scheduleWeekday: null, scheduleMonthday: null })).toBeNull();
    expect(() => assertAuditReportTimezone('not/a-zone')).toThrow('valid IANA timezone');
  });
});
