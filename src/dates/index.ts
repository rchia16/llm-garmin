import { dateSchema } from "../domain/index.js";

// Date helpers accept an injected instant and timezone so tests never depend on the machine clock.

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export function validateIsoDate(value: string): string {
  dateSchema.parse(value);
  const [yearPart, monthPart, dayPart] = value.split("-");
  const year = Number(yearPart);
  const month = Number(monthPart);
  const day = Number(dayPart);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`Invalid calendar date: ${value}`);
  }
  return value;
}

function datePartsInTimeZone(referenceDate: Date, timeZone: string): { year: number; month: number; day: number } {
  // Intl handles daylight-saving and local-calendar conversion without persisting a time of day.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(referenceDate);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day) };
}

function formatParts(parts: { year: number; month: number; day: number }): string {
  return `${parts.year.toString().padStart(4, "0")}-${parts.month.toString().padStart(2, "0")}-${parts.day.toString().padStart(2, "0")}`;
}

export function todayInTimeZone(referenceDate: Date, timeZone: string): string {
  return formatParts(datePartsInTimeZone(referenceDate, timeZone));
}

export function tomorrowInTimeZone(referenceDate: Date, timeZone: string): string {
  const today = datePartsInTimeZone(referenceDate, timeZone);
  const next = new Date(Date.UTC(today.year, today.month - 1, today.day + 1));
  return formatParts({ year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() });
}

export function nextOccurrenceOfWeekday(
  referenceDate: Date,
  timeZone: string,
  weekday: Weekday,
): string {
  const today = datePartsInTimeZone(referenceDate, timeZone);
  const date = new Date(Date.UTC(today.year, today.month - 1, today.day));
  const daysUntil = (weekday - date.getUTCDay() + 7) % 7 || 7;
  date.setUTCDate(date.getUTCDate() + daysUntil);
  return formatParts({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() });
}
