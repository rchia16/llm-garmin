import type { SwimmingTarget } from "../domain/index.js";

// Swimming keeps threshold/CSS offsets instead of converting them into permanent paces.

// TrainingPeaks' Joe Friel swimming calculator uses seven threshold-pace bands.
// Pace multipliers are seconds-per-100, so a larger multiplier is a slower pace.
export const joeFrielTrainingPeaksSwimmingZones = {
  z1_recovery: [1.30, null],
  z2_aerobic: [1.14, 1.29],
  z3_tempo: [1.06, 1.13],
  z4_threshold: [1.01, 1.05],
  z5a_super_threshold: [0.97, 1.00],
  z5b_anaerobic_endurance: [0.90, 0.96],
  z5c_power: [null, 0.89],
  // Natural-language "Z5" means the complete Z5a-c family.
  z5_aggregate: [null, 1.00],
} as const;

export type SwimmingZone = keyof typeof joeFrielTrainingPeaksSwimmingZones;

function scaledPace(thresholdPaceSecPer100m: number, multiplier: number): number {
  // Remove binary floating-point noise while preserving sub-second profile values.
  return Math.round(thresholdPaceSecPer100m * multiplier * 1_000_000) / 1_000_000;
}

export function resolveSwimmingOffset(
  thresholdPaceSecPer100m: number,
  offsetSecPer100m: number,
): number {
  if (!Number.isFinite(thresholdPaceSecPer100m) || thresholdPaceSecPer100m <= 0) {
    throw new Error("Swimming threshold pace must be positive and finite.");
  }
  if (!Number.isFinite(offsetSecPer100m)) {
    throw new Error("Swimming pace offset must be finite.");
  }
  const resolved = thresholdPaceSecPer100m + offsetSecPer100m;
  if (resolved <= 0) throw new Error("Resolved swimming pace must be positive.");
  return resolved;
}

export function secondsPer100mToPaceString(secondsPer100m: number): string {
  if (!Number.isFinite(secondsPer100m) || secondsPer100m <= 0) {
    throw new Error("Swimming pace must be positive and finite.");
  }
  const roundedSeconds = Math.round(secondsPer100m);
  return `${Math.floor(roundedSeconds / 60)}:${(roundedSeconds % 60).toString().padStart(2, "0")}/100m`;
}

export function resolveSwimmingZone(
  thresholdPaceSecPer100m: number,
  zone: SwimmingZone,
): { paceSecPer100m: number; rangePaceSecPer100m?: [number, number] } {
  if (!Number.isFinite(thresholdPaceSecPer100m) || thresholdPaceSecPer100m <= 0) {
    throw new Error("Swimming threshold pace must be positive and finite.");
  }
  const [fastMultiplier, slowMultiplier] = joeFrielTrainingPeaksSwimmingZones[zone];
  const paceSecPer100m = scaledPace(thresholdPaceSecPer100m, fastMultiplier ?? slowMultiplier ?? 1);
  if (fastMultiplier === null || slowMultiplier === null) return { paceSecPer100m };
  return {
    paceSecPer100m,
    rangePaceSecPer100m: [
      scaledPace(thresholdPaceSecPer100m, fastMultiplier),
      scaledPace(thresholdPaceSecPer100m, slowMultiplier),
    ],
  };
}

export function resolveSwimmingTarget(
  target: SwimmingTarget,
  thresholdPaceSecPer100m: number,
): SwimmingTarget {
  if (target.source === "explicit") return target;
  if (target.prescriptionKind === "pace_zone") {
    return {
      ...target,
      resolved: { kind: "swimming_pace", ...resolveSwimmingZone(thresholdPaceSecPer100m, target.zone) },
    };
  }
  return {
    ...target,
    resolved: {
      kind: "swimming_pace",
      paceSecPer100m: resolveSwimmingOffset(thresholdPaceSecPer100m, target.offsetSecPer100m),
    },
  };
}
