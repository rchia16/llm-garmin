import type { RunningTarget } from "../domain/index.js";

// Running intensity is calculated in speed space, then converted back to pace.

// Published Friel running PACE multipliers, not the rounded speed percentages.
// https://www.trainingpeaks.com/learn/articles/joe-friel-s-quick-guide-to-setting-zones/
// Larger seconds/km multipliers are slower; null denotes an unbounded end.
export const frielTrainingPeaksZones = {
  z1_recovery: [1.29, null],
  z2_aerobic: [1.14, 1.29],
  z3_tempo: [1.06, 1.13],
  z4_threshold: [0.99, 1.05],
  z5a_super_threshold: [0.97, 1.00],
  z5b_aerobic_capacity: [0.90, 0.96],
  z5c_anaerobic_capacity: [null, 0.90],
  z5_aggregate: [null, 1.00],
} as const;

export type RunningZone = keyof typeof frielTrainingPeaksZones;

export const runningZoneLabels: Readonly<Record<string, RunningZone>> = {
  "1": "z1_recovery", "2": "z2_aerobic", "3": "z3_tempo", "4": "z4_threshold",
  "5": "z5_aggregate", "5a": "z5a_super_threshold", "5b": "z5b_aerobic_capacity", "5c": "z5c_anaerobic_capacity",
};

export function paceStringToSecondsPerKm(value: string): number {
  const match = /^(\d+):([0-5]\d)(?:\/km)?$/.exec(value.trim());
  if (!match) {
    throw new Error(`Invalid pace: ${value}. Expected M:SS or M:SS/km.`);
  }
  const minutes = Number(match[1]);
  const seconds = Number(match[2]);
  return minutes * 60 + seconds;
}

export function secondsPerKmToPaceString(secondsPerKm: number): string {
  if (!Number.isFinite(secondsPerKm) || secondsPerKm <= 0) {
    throw new Error("Pace must be a positive finite number.");
  }
  const roundedSeconds = Math.round(secondsPerKm);
  const minutes = Math.floor(roundedSeconds / 60);
  const seconds = roundedSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}/km`;
}

export function runningPaceLabel(resolved: NonNullable<RunningTarget["resolved"]>): string {
  const pace = secondsPerKmToPaceString(resolved.paceSecPerKm);
  if (resolved.paceBoundary !== undefined) {
    const prefix = { slower_than: ">", faster_than: "<", at_or_faster_than: "≤" }[resolved.paceBoundary];
    return `${prefix}${pace}`;
  }
  const range = resolved.rangePaceSecPerKm;
  return range === undefined ? pace : `${secondsPerKmToPaceString(range[0]).replace("/km", "")}–${secondsPerKmToPaceString(range[1])}`;
}

export function parseRunningPaceText(value: string): { paceSecPerKm: number; rangePaceSecPerKm?: [number, number] } | undefined {
  const match = /^(\d+:[0-5]\d)(?:\s*[-–—]\s*(\d+:[0-5]\d))?\s*(?:(?:min(?:utes?)?\s*)?\/\s*km)?$/i.exec(value.trim());
  if (match === null) return undefined;
  const fast = paceStringToSecondsPerKm(match[1]!);
  const slow = match[2] === undefined ? undefined : paceStringToSecondsPerKm(match[2]);
  if (!Number.isFinite(fast) || fast <= 0 || (slow !== undefined && (!Number.isFinite(slow) || slow <= 0 || fast > slow))) return undefined;
  return slow === undefined ? { paceSecPerKm: fast } : { paceSecPerKm: fast, rangePaceSecPerKm: [fast, slow] };
}

export function paceToMetresPerSecond(secondsPerKm: number): number {
  if (!Number.isFinite(secondsPerKm) || secondsPerKm <= 0) {
    throw new Error("Pace must be a positive finite number.");
  }
  return 1000 / secondsPerKm;
}

export function metresPerSecondToPace(metresPerSecond: number): number {
  if (!Number.isFinite(metresPerSecond) || metresPerSecond <= 0) {
    throw new Error("Speed must be a positive finite number.");
  }
  return 1000 / metresPerSecond;
}

export function resolveThresholdSpeedFraction(
  thresholdPaceSecPerKm: number,
  fraction: number,
): number {
  if (thresholdPaceSecPerKm <= 0 || fraction <= 0) {
    throw new Error("Threshold pace and speed fraction must be positive.");
  }
  // Pace is inversely proportional to speed, so this is not a fixed-second offset.
  return thresholdPaceSecPerKm / fraction;
}

export function resolveThresholdSpeedRange(
  thresholdPaceSecPerKm: number,
  fractions: readonly [number, number],
): [number, number] {
  const [lowerFraction, upperFraction] = fractions;
  if (lowerFraction <= 0 || upperFraction <= 0 || lowerFraction > upperFraction) {
    throw new Error("Speed fractions must be positive and ordered.");
  }
  return [
    resolveThresholdSpeedFraction(thresholdPaceSecPerKm, upperFraction),
    resolveThresholdSpeedFraction(thresholdPaceSecPerKm, lowerFraction),
  ];
}

export function resolveRunningZone(
  thresholdPaceSecPerKm: number,
  zone: RunningZone,
): { paceSecPerKm: number; rangePaceSecPerKm?: [number, number]; paceBoundary?: "slower_than" | "faster_than" | "at_or_faster_than" } {
  if (!Number.isFinite(thresholdPaceSecPerKm) || thresholdPaceSecPerKm <= 0) throw new Error("Running threshold pace must be positive and finite.");
  const [fastMultiplier, slowMultiplier] = frielTrainingPeaksZones[zone];
  // Convert published pace ratios to inverse speed fractions before scaling.
  const scale = (multiplier: number): number => Math.round(resolveThresholdSpeedFraction(thresholdPaceSecPerKm, 1 / multiplier) * 1_000_000) / 1_000_000;
  if (fastMultiplier === null || slowMultiplier === null) {
    return {
      paceSecPerKm: scale(fastMultiplier ?? slowMultiplier ?? 1),
      paceBoundary: zone === "z1_recovery" ? "slower_than" : zone === "z5_aggregate" ? "at_or_faster_than" : "faster_than",
    };
  }
  const rangePaceSecPerKm: [number, number] = [scale(fastMultiplier), scale(slowMultiplier)];
  return {
    paceSecPerKm: rangePaceSecPerKm[0],
    rangePaceSecPerKm,
  };
}

export function resolveRunningTarget(
  target: RunningTarget,
  thresholdPaceSecPerKm: number,
): RunningTarget {
  if (target.source === "explicit") return target;
  const resolved = target.prescriptionKind === "threshold_speed_fraction"
    ? { kind: "running_pace" as const, paceSecPerKm: resolveThresholdSpeedFraction(thresholdPaceSecPerKm, target.fraction) }
    : { kind: "running_pace" as const, ...resolveRunningZone(thresholdPaceSecPerKm, target.zone as RunningZone) };
  return { ...target, resolved };
}
