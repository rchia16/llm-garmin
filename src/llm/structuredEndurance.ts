import { parsedWorkoutSchema, type ParsedDuration, type ParsedStep, type ParsedWorkout } from "./schema.js";
import { isRunningEffortPhrase } from "./runningEffort.js";
import { runningZoneLabels } from "../engine/running.js";
import { isRunningZoneAnnotation, parseClockRunningStep } from "./clockRunning.js";

type Sport = "running" | "cycling";
type Section = "warmup" | "work" | "cooldown";

const sectionByHeading: Record<string, Section> = {
  "warm up": "warmup",
  warmup: "warmup",
  "main set": "work",
  "cool down": "cooldown",
  cooldown: "cooldown",
  "warm down": "cooldown",
};

const cyclingZones = ["recovery", "endurance", "tempo", "threshold", "vo2max", "anaerobic"] as const;

function splitOutsideParens(value: string, separator: string): string[] | undefined {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "(") depth += 1;
    if (value[index] === ")") depth -= 1;
    if (depth < 0) return undefined;
    if (value[index] === separator && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (depth !== 0) return undefined;
  parts.push(value.slice(start).trim());
  return parts.every(Boolean) ? parts : undefined;
}

function logicalLines(sourcePrompt: string): string[] | undefined {
  const lines: string[] = [];
  let pending = "";
  let depth = 0;
  for (const line of sourcePrompt.split(/\r?\n/).map((part) => part.trim()).filter(Boolean)) {
    pending = pending.length === 0 ? line : `${pending} ${line}`;
    for (const character of line) {
      if (character === "(") depth += 1;
      if (character === ")") depth -= 1;
      if (depth < 0) return undefined;
    }
    if (depth === 0) {
      lines.push(pending);
      pending = "";
    }
  }
  return depth === 0 ? lines : undefined;
}

function durationFor(value: number, unit: string | undefined, allowBareMinutes: boolean): ParsedDuration | undefined {
  if (!Number.isFinite(value) || value <= 0) return undefined;
  if (unit === undefined) return allowBareMinutes ? { kind: "time", seconds: value * 60 } : undefined;
  if (/^(?:mins?|minutes?)$/i.test(unit)) return { kind: "time", seconds: value * 60 };
  if (/^(?:secs?|seconds?)$/i.test(unit)) return { kind: "time", seconds: value };
  if (/^km$/i.test(unit)) return { kind: "distance", metres: value * 1000 };
  if (/^(?:m|metres?|meters?)$/i.test(unit)) return { kind: "distance", metres: value };
  return undefined;
}

export function parseStructuredEndurance(sourcePrompt: string, sport: Sport): ParsedWorkout | undefined {
  const lines = logicalLines(sourcePrompt);
  if (lines === undefined) return undefined;
  if (sport === "running") {
    for (let index = 1; index < lines.length; index += 1) {
      if (isRunningZoneAnnotation(lines[index]!) && parseClockRunningStep(lines[index - 1]!) !== undefined) {
        lines[index - 1] += ` ${lines[index]}`;
        lines.splice(index, 1);
        index -= 1;
      }
    }
  }
  const hasMinuteUnit = /\b\d+(?:\.\d+)?\s*(?:mins?|minutes?)\b/i.test(sourcePrompt);
  const hasDistanceUnit = /\b\d+(?:\.\d+)?\s*(?:km|metres?|meters?|m)\b/i.test(sourcePrompt);
  const allowBareMinutes = sport === "cycling" && hasMinuteUnit && !hasDistanceUnit;
  let section: Section | undefined;
  let sawHeading = false;
  let sawClock = false;
  let nextId = 0;
  const steps: ParsedStep[] = [];

  const parseComponent = (text: string): ParsedStep | undefined => {
    if (sport === "running") {
      const clock = parseClockRunningStep(text);
      if (clock !== undefined) {
        sawClock = true;
        nextId += 1;
        return { ...clock, id: `${sport}-${nextId}`, type: section ?? "work" };
      }
    }
    if (sport === "running" && section !== undefined) {
      const effort = /^(\d+(?:\.\d+)?)\s*(mins?|minutes?|secs?|seconds?|km|metres?|meters?|m)\s+(?:(recoveries|recovery)\s+)?(?:(?:at|in)\s+)?(.+?)(?:\s+(?:in|at)\s+Z([1-5](?:[abc])?))?$/i.exec(text);
      if (effort !== null && isRunningEffortPhrase(effort[4] ?? "")) {
        const duration = durationFor(Number(effort[1]), effort[2], false);
        if (duration === undefined) return undefined;
        nextId += 1;
        const notes = effort[4] ?? "";
        const isRecovery = effort[3] !== undefined || /\b(?:recover(?:y|ies)|float)\b/i.test(notes);
        const zone = effort[5] === undefined ? undefined : runningZoneLabels[effort[5].toLowerCase()];
        if (effort[5] !== undefined && zone === undefined) return undefined;
        return {
          id: `${sport}-${nextId}`, type: isRecovery && section === "work" ? "recovery" : section, duration, notes,
          ...(zone === undefined ? {} : { target: { kind: "running_zone", zone } }),
        };
      }
    }
    const match = /^(\d+(?:\.\d+)?)\s*(mins?|minutes?|secs?|seconds?|km|metres?|meters?|m)?\s+(?:(recoveries|recovery)\s+)?(?:in|at)\s+(?:(low|lower|upper|high)\s+)?Z([1-6](?:[abc])?)(?:\s*-\s*([1-6](?:[abc])?))?$/i.exec(text);
    if (match === null || section === undefined) return undefined;
    const duration = durationFor(Number(match[1]), match[2], allowBareMinutes);
    if (duration === undefined) return undefined;
    const firstZone = match[5]?.toLowerCase() ?? "";
    const lastZone = match[6]?.toLowerCase() ?? firstZone;
    const labels = sport === "running" ? Object.keys(runningZoneLabels) : ["1", "2", "3", "4", "5", "6"];
    if (!labels.includes(firstZone) || !labels.includes(lastZone) || labels.indexOf(firstZone) > labels.indexOf(lastZone)) return undefined;

    nextId += 1;
    const isRecovery = match[3] !== undefined;
    const qualifier = match[4]?.toLowerCase();
    const zoneNote = `${qualifier === undefined ? "" : `${qualifier} `}Z${firstZone}${lastZone === firstZone ? "" : `-${lastZone}`}`;
    const zone = sport === "running" ? runningZoneLabels[firstZone] : cyclingZones[Number(firstZone) - 1];
    const target = firstZone === lastZone && zone !== undefined
      ? sport === "running"
        ? { kind: "running_zone" as const, zone: runningZoneLabels[firstZone]! }
        : { kind: "cycling_zone" as const, zone: zone as typeof cyclingZones[number] }
      : undefined;
    return {
      id: `${sport}-${nextId}`,
      type: isRecovery ? "recovery" : section,
      duration,
      ...(target === undefined ? {} : { target }),
      ...(qualifier === undefined && firstZone === lastZone ? {} : { notes: zoneNote }),
    };
  };

  for (const line of lines) {
    const heading = /^([^:]+):$/.exec(line);
    if (heading !== null) {
      const key = heading[1]?.toLowerCase().replace(/\s+/g, " ").trim() ?? "";
      section = sectionByHeading[key];
      if (section === undefined) return undefined;
      sawHeading = true;
      continue;
    }
    const groups = splitOutsideParens(line.replace(/[.,;]\s*$/, ""), ",");
    if (groups === undefined) return undefined;
    for (const group of groups) {
      const repeat = /^(\d+)\s*[x\u00d7]\s*\((.*)\)$/i.exec(group);
      const repetitions = repeat === null ? 1 : Number(repeat[1]);
      if (!Number.isSafeInteger(repetitions) || repetitions < 1) return undefined;
      const components = splitOutsideParens(repeat?.[2] ?? group, "+");
      if (components === undefined) return undefined;
      const children: ParsedStep[] = [];
      for (const component of components) {
        const step = parseComponent(component);
        if (step === undefined) return undefined;
        children.push(step);
      }
      if (repetitions === 1) {
        steps.push(...children);
      } else {
        nextId += 1;
        steps.push({ id: `${sport}-${nextId}`, type: "repeat", repetitions, steps: children });
      }
    }
  }

  if ((!sawHeading && !sawClock) || steps.length === 0) return undefined;
  const result = parsedWorkoutSchema.safeParse({
    name: sport === "running" ? "Run workout" : "Ride workout",
    sport,
    scheduledDate: null,
    steps,
    profileUpdates: [],
  });
  return result.success ? result.data : undefined;
}
