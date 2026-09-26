import type { RunningTarget } from "../domain/index.js";

// Running intensity is calculated in speed space, then converted back to pace.

export const frielTrainingPeaksZones = {
  z1_recovery: [0.65, 0.80],
  z2_aerobic: [0.80, 0.88],
  z3_tempo: [0.88, 0.95],
  z4_threshold: [0.95, 1.00],
  z5_anaerobic: [1.00, 1.10],
} as const;

// These ranges represent the named Friel/TrainingPeaks threshold-speed convention.

export type RunningZone = keyof typeof frielTrainingPeaksZones;

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
): { paceSecPerKm: number; rangePaceSecPerKm: [number, number] } {
  const fractions = frielTrainingPeaksZones[zone];
  const rangePaceSecPerKm = resolveThresholdSpeedRange(thresholdPaceSecPerKm, fractions);
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
