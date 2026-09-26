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
