import { athleteProfileSchema, type AthleteProfile } from "../domain/index.js";

// Profile updates validate and return new objects so recalculation remains deterministic.

type BaselineSource = "manual" | "prompt" | "imported";

type UpdateMetadata = {
  source?: BaselineSource;
  updatedAt?: string;
};

function metadata(value: number, update: UpdateMetadata) {
  return {
    value,
    source: update.source ?? "manual",
    updatedAt: update.updatedAt ?? new Date().toISOString(),
  } as const;
}

function validatePositive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be positive and finite.`);
}

export function updateRunningThreshold(
  profile: AthleteProfile,
  thresholdPaceSecPerKm: number,
  update: UpdateMetadata = {},
): AthleteProfile {
  validatePositive(thresholdPaceSecPerKm, "Running threshold pace");
  return athleteProfileSchema.parse({
    ...profile,
    running: { ...profile.running, thresholdPaceSecPerKm: metadata(thresholdPaceSecPerKm, update) },
  });
}

export function updateCyclingFTP(
  profile: AthleteProfile,
  ftpWatts: number,
  update: UpdateMetadata = {},
): AthleteProfile {
  validatePositive(ftpWatts, "Cycling FTP");
  return athleteProfileSchema.parse({
    ...profile,
    cycling: { ...profile.cycling, ftpWatts: metadata(ftpWatts, update) },
  });
}

export function updateSwimmingThreshold(
  profile: AthleteProfile,
  thresholdPaceSecPer100m: number,
  update: UpdateMetadata = {},
): AthleteProfile {
  validatePositive(thresholdPaceSecPer100m, "Swimming threshold pace");
  return athleteProfileSchema.parse({
    ...profile,
    swimming: { ...profile.swimming, thresholdPaceSecPer100m: metadata(thresholdPaceSecPer100m, update) },
  });
}
