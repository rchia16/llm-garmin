import type { CyclingTarget, RunningTarget, SwimmingTarget } from "../domain/index.js";

// Constructors make it hard for fixtures and future parsers to lose prescription metadata.

export function explicitRunningPace(paceSecPerKm: number): RunningTarget {
  return {
    sport: "running",
    prescriptionKind: "explicit_pace",
    source: "explicit",
    paceSecPerKm,
    resolved: { kind: "running_pace", paceSecPerKm },
  };
}

export function thresholdRunningTarget(fraction = 1): RunningTarget {
  return {
    sport: "running",
    prescriptionKind: "threshold_speed_fraction",
    source: "profile_derived",
    fraction,
  };
}

export function explicitRunningPaceRange(fastPaceSecPerKm: number, slowPaceSecPerKm: number): RunningTarget {
  if (!Number.isFinite(fastPaceSecPerKm) || !Number.isFinite(slowPaceSecPerKm) || fastPaceSecPerKm <= 0 || fastPaceSecPerKm > slowPaceSecPerKm) {
    throw new Error("Explicit running pace range must be positive, finite, and ordered from faster to slower.");
  }
  const rangePaceSecPerKm: [number, number] = [fastPaceSecPerKm, slowPaceSecPerKm];
  return {
    sport: "running", prescriptionKind: "explicit_pace", source: "explicit", paceSecPerKm: fastPaceSecPerKm, rangePaceSecPerKm,
    resolved: { kind: "running_pace", paceSecPerKm: fastPaceSecPerKm, rangePaceSecPerKm },
  };
}

export function runningZoneTarget(zone: keyof typeof import("./running.js").frielTrainingPeaksZones): RunningTarget {
  return {
    sport: "running",
    prescriptionKind: "pace_zone",
    source: "profile_derived",
    zoneSystem: "friel_trainingpeaks",
    zone,
  };
}

export function explicitCyclingWatts(watts: number): CyclingTarget {
  return {
    sport: "cycling",
    prescriptionKind: "explicit_watts",
    source: "explicit",
    watts,
    resolved: { kind: "cycling_power", watts },
  };
}

export function ftpTarget(fraction: number): CyclingTarget {
  return { sport: "cycling", prescriptionKind: "ftp_fraction", source: "profile_derived", fraction };
}

export function cyclingZoneTarget(zone: keyof typeof import("./cycling.js").cogganPowerZones): CyclingTarget {
  return { sport: "cycling", prescriptionKind: "power_zone", source: "profile_derived", zoneSystem: "coggan", zone };
}

export function explicitSwimmingPace(paceSecPer100m: number): SwimmingTarget {
  return {
    sport: "swimming",
    prescriptionKind: "explicit_pace",
    source: "explicit",
    paceSecPer100m,
    resolved: { kind: "swimming_pace", paceSecPer100m },
  };
}

export function swimmingThresholdOffset(offsetSecPer100m: number): SwimmingTarget {
  return { sport: "swimming", prescriptionKind: "threshold_offset", source: "profile_derived", offsetSecPer100m };
}

export function swimmingZoneTarget(zone: keyof typeof import("./swimming.js").joeFrielTrainingPeaksSwimmingZones): SwimmingTarget {
  return {
    sport: "swimming",
    prescriptionKind: "pace_zone",
    source: "profile_derived",
    zoneSystem: "joe_friel_trainingpeaks",
    zone,
  };
}

// Default running prescriptions are semantic; the running engine resolves them from threshold pace.
export function defaultRunningTarget(stepType: "warmup" | "work" | "recovery" | "cooldown" | "rest"): RunningTarget | undefined {
  if (stepType === "work") return thresholdRunningTarget();
  if (stepType === "warmup" || stepType === "recovery" || stepType === "cooldown") return runningZoneTarget("z1_recovery");
  return undefined;
}
