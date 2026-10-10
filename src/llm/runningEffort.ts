import type { RunningZone } from "../engine/running.js";
import type { ParsedDuration } from "./schema.js";

// App defaults for qualitative effort, not a published Friel word-to-zone
// standard. Running pace is resolved from the running threshold, never CSS.
export function isOpenRunningEffort(notes: string | undefined): boolean {
  return notes !== undefined && /\b(?:max(?:imal|imum)? effort|time trial|build|progressive|sprint|all[- ]out|moderate|strides?|fast[- ]relaxed|target (?:unspecified|unknown|required))\b/i.test(notes);
}

export function runningEffortZone(notes: string | undefined, duration?: ParsedDuration): RunningZone | undefined {
  if (notes === undefined || /\b(?:max(?:imal|imum)? effort|time trial|build|progressive|moderate|strides?|fast[- ]relaxed|target (?:unspecified|unknown|required))\b/i.test(notes)) return undefined;
  const short = duration?.kind === "time" ? duration.seconds <= 120 : duration?.kind === "distance" && duration.metres <= 400;
  const veryShort = duration?.kind === "time" ? duration.seconds <= 60 : duration?.kind === "distance" && duration.metres <= 200;
  const sprint = duration?.kind === "time" ? duration.seconds <= 30 : duration?.kind === "distance" && duration.metres <= 100;
  if (/\b(?:sprint|all[- ]out)\b/i.test(notes)) return sprint ? "z5c_anaerobic_capacity" : undefined;
  if (/\bfloat(?: recovery)?\b/i.test(notes)) return "z2_aerobic";
  if (/\b(?:very easy|easy|active recovery)\b/i.test(notes)) return "z1_recovery";
  if (/\bsteady\b/i.test(notes)) return "z2_aerobic";
  if (/\b(?:tempo|moderately hard)\b/i.test(notes)) return "z3_tempo";
  if (/\bthreshold\b/i.test(notes)) return "z4_threshold";
  if (/\bvery hard\b/i.test(notes)) return veryShort ? "z5b_aerobic_capacity" : "z5a_super_threshold";
  if (/\bhard\b/i.test(notes)) return short ? "z5a_super_threshold" : "z4_threshold";
  return undefined;
}

// Structured input must match a whole effort phrase; recognising a word inside
// arbitrary instructions would silently discard requested changes.
export function isRunningEffortPhrase(value: string): boolean {
  return /^(?:very easy|easy|steady|moderately hard|moderate|tempo|threshold|very hard|hard|active recovery|float(?: recovery)?|sprint|all[- ]out|max(?:imal|imum)? effort(?: time trial)?|time trial|build(?: easy to hard)?|progressive)(?:\s+recover(?:y|ies))?$/i.test(value);
}
