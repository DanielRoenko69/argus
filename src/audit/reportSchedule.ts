import type { AuditReportCadence } from './reportTypes.js';

export interface AuditReportScheduleInput {
  cadence: AuditReportCadence;
  timezone: string;
  scheduleHour: number;
  scheduleWeekday: number | null;
  scheduleMonthday: number | null;
}

function zonedParts(date: Date, timezone: string): Record<string, number> {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  return Object.fromEntries(formatter.formatToParts(date)
    .filter(part => part.type !== 'literal')
    .map(part => [part.type, Number(part.value)]));
}

function timezoneOffsetMs(date: Date, timezone: string): number {
  const part = zonedParts(date, timezone);
  const representedAsUtc = Date.UTC(part['year']!, part['month']! - 1, part['day']!, part['hour']!, part['minute']!, part['second']!);
  return representedAsUtc - date.getTime();
}

function zonedToUtc(year: number, month: number, day: number, hour: number, timezone: string): Date {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, 0, 0));
  const first = new Date(guess.getTime() - timezoneOffsetMs(guess, timezone));
  return new Date(guess.getTime() - timezoneOffsetMs(first, timezone));
}

export function assertAuditReportTimezone(timezone: string): string {
  const value = timezone.trim();
  if (!value || value.length > 64) throw new Error('timezone must be a valid IANA timezone');
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(); } catch { throw new Error('timezone must be a valid IANA timezone'); }
  return value;
}

export function nextAuditReportRun(schedule: AuditReportScheduleInput, after = new Date()): Date | null {
  if (schedule.cadence === 'manual') return null;
  const timezone = assertAuditReportTimezone(schedule.timezone);
  if (!Number.isInteger(schedule.scheduleHour) || schedule.scheduleHour < 0 || schedule.scheduleHour > 23) {
    throw new Error('scheduleHour must be between 0 and 23');
  }
  const local = zonedParts(after, timezone);
  for (let addDays = 0; addDays <= 370; addDays += 1) {
    const candidateDay = new Date(Date.UTC(local['year']!, local['month']! - 1, local['day']! + addDays));
    const weekday = candidateDay.getUTCDay();
    const monthday = candidateDay.getUTCDate();
    if (schedule.cadence === 'weekly' && weekday !== schedule.scheduleWeekday) continue;
    if (schedule.cadence === 'monthly' && monthday !== schedule.scheduleMonthday) continue;
    const candidate = zonedToUtc(
      candidateDay.getUTCFullYear(), candidateDay.getUTCMonth() + 1, monthday,
      schedule.scheduleHour, timezone,
    );
    if (candidate.getTime() > after.getTime()) return candidate;
  }
  throw new Error('could not calculate the next audit report run');
}
