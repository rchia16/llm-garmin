import type { SwimmingZone } from "../engine/swimming.js";
import type { ParsedDuration } from "./schema.js";

// These are app defaults for qualitative swim instructions, not a TrainingPeaks
// word-to-zone standard. Pace is still resolved separately from the CSS profile.
export function isOpenSwimEffort(notes: string): boolean {
  return /\b(?:max(?:imal)? effort|time trial|build\b|progressive\b)\b/i.test(notes);
}

export function swimmingEffortZone(notes: string | undefined, duration: ParsedDuration): SwimmingZone | undefined {
  if (notes === undefined || isOpenSwimEffort(notes)) return undefined;
  const shortSwim = duration.kind === "distance" && duration.metres <= 100;
  const sprint = duration.kind === "distance" && duration.metres <= 50;
  if (/\b(?:sprint|all[- ]out)\b/i.test(notes)) return sprint ? "z5c_power" : undefined;
  if (/\b(?:very easy|easy|active recovery)\b/i.test(notes)) return "z1_recovery";
  if (/\bsteady\b/i.test(notes)) return "z2_aerobic";
  if (/\bmoderately hard\b/i.test(notes)) return "z3_tempo";
  if (/\bmoderate\b/i.test(notes)) return undefined;
  if (/\bvery hard\b/i.test(notes)) return sprint ? "z5b_anaerobic_endurance" : "z5a_super_threshold";
  if (/\bhard\b/i.test(notes)) return shortSwim ? "z5a_super_threshold" : "z4_threshold";
  return undefined;
}
