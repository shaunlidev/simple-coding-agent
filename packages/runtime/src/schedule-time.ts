import cron from "node-cron";
import { CronExpressionParser } from "cron-parser";
import { z } from "zod";

export type ScheduleClock = { cron: string; timezone?: string };

function invalid(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 400 });
}

export function intervalMs(expression: string): number | undefined {
  const match = expression.trim().match(/^@?every\s+(\d+)\s*([smhd])$/i);
  if (!match) return undefined;
  const units: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  const value = Number(match[1]) * (units[match[2]?.toLowerCase() ?? ""] ?? 0);
  if (!Number.isSafeInteger(value) || value < 1000 || value > 366 * 86_400_000) throw invalid("Interval must be between 1 second and 366 days");
  return value;
}

export function validateScheduleClock(schedule: ScheduleClock): void {
  try { new Intl.DateTimeFormat("en", { timeZone: schedule.timezone ?? "Asia/Shanghai" }); }
  catch { throw invalid("Invalid IANA timezone"); }
  if (intervalMs(schedule.cron) !== undefined) return;
  if (!cron.validate(schedule.cron)) throw invalid("Invalid cron expression");
  try { CronExpressionParser.parse(schedule.cron, { tz: schedule.timezone ?? "Asia/Shanghai" }).next(); }
  catch { throw invalid("Cron expression has no supported next occurrence"); }
}

export function parseScheduleDate(value: string): Date {
  const result = z.iso.datetime({ offset: true }).safeParse(value);
  if (!result.success || !Number.isFinite(new Date(value).getTime())) throw invalid("Invalid schedule timestamp");
  return new Date(value);
}

export function nextRunAt(schedule: ScheduleClock, from: Date = new Date()): string {
  validateScheduleClock(schedule);
  if (!Number.isFinite(from.getTime())) throw invalid("Invalid schedule timestamp");
  const interval = intervalMs(schedule.cron);
  if (interval !== undefined) return new Date(from.getTime() + interval).toISOString();
  return CronExpressionParser.parse(schedule.cron, { currentDate: from, tz: schedule.timezone ?? "Asia/Shanghai" }).next().toDate().toISOString();
}

export function coalesceDue(schedule: ScheduleClock & { nextRunAt: string }, now: Date) {
  const first = parseScheduleDate(schedule.nextRunAt);
  if (first > now) throw invalid("Schedule is not due");
  const interval = intervalMs(schedule.cron);
  if (interval !== undefined) {
    const count = Math.floor((now.getTime() - first.getTime()) / interval) + 1;
    return { first: first.toISOString(), last: new Date(first.getTime() + (count - 1) * interval).toISOString(), count, next: new Date(first.getTime() + count * interval).toISOString() };
  }
  const last = CronExpressionParser.parse(schedule.cron, { currentDate: new Date(now.getTime() + 1), tz: schedule.timezone ?? "Asia/Shanghai" }).prev().toDate();
  // Record the missed range without unbounded iteration or inventing an occurrence count.
  return { first: first.toISOString(), last: (last < first ? first : last).toISOString(), next: nextRunAt(schedule, now) };
}
