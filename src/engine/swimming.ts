import type { SwimmingTarget } from "../domain/index.js";

// Swimming keeps threshold/CSS offsets instead of converting them into permanent paces.

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

export function resolveSwimmingTarget(
  target: SwimmingTarget,
  thresholdPaceSecPer100m: number,
): SwimmingTarget {
  if (target.source === "explicit") return target;
  return {
    ...target,
    resolved: {
      kind: "swimming_pace",
      paceSecPer100m: resolveSwimmingOffset(thresholdPaceSecPer100m, target.offsetSecPer100m),
    },
  };
}
