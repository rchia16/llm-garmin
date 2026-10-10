import { parseRunningPaceText, runningZoneLabels } from "../engine/running.js";
import type { ParsedStep } from "./schema.js";

export function isRunningZoneAnnotation(text: string): boolean {
  const match = /^(?:Zone\s*|Z)([1-5](?:[abc])?)(?:\s*[-–—]\s*(?:Zone\s*|Z)?([1-5](?:[abc])?))?$/i.exec(text.trim());
  if (match === null) return false;
  const labels = Object.keys(runningZoneLabels);
  const first = labels.indexOf(match[1]!.toLowerCase());
  const last = labels.indexOf((match[2] ?? match[1])!.toLowerCase());
  return first >= 0 && last >= first;
}

// Two components mean minutes:seconds; three mean hours:minutes:seconds.
export function parseClockRunningStep(text: string): Omit<Extract<ParsedStep, { type: "work" | "warmup" | "cooldown" | "recovery" | "rest" }>, "id" | "type"> | undefined {
  const match = /^(\d+:[0-5]\d(?::[0-5]\d)?)\s*@\s*(\d+:[0-5]\d(?:\s*[-–—]\s*\d+:[0-5]\d)?\s*(?:min(?:utes?)?\s*)?\/\s*km)(?:\s+(.+))?$/i.exec(text.trim());
  if (match === null) return undefined;
  const parts = match[1]!.split(":").map(Number);
  const seconds = parts.length === 3 ? parts[0]! * 3600 + parts[1]! * 60 + parts[2]! : parts[0]! * 60 + parts[1]!;
  const pace = parseRunningPaceText(match[2]!);
  const notes = match[3];
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || pace === undefined || (notes !== undefined && !isRunningZoneAnnotation(notes))) return undefined;
  return { duration: { kind: "time", seconds }, target: { kind: "explicit_running_pace", ...pace }, ...(notes === undefined ? {} : { notes }) };
}
