import { athleteProfileSchema, type AthleteProfile } from "../../src/domain/index.js";

// Fixed profiles keep calculation tests independent of the current date and machine state.

export const emptyProfile: AthleteProfile = athleteProfileSchema.parse({
  id: "athlete-1",
  running: { paceZoneSystem: "friel_trainingpeaks" },
  cycling: { powerZoneSystem: "coggan" },
  swimming: { thresholdMethod: "css" },
});

export const completeProfile: AthleteProfile = athleteProfileSchema.parse({
  id: "athlete-1",
  running: {
    thresholdPaceSecPerKm: { value: 265, source: "manual", updatedAt: "2026-01-01T08:00:00.000Z" },
    paceZoneSystem: "friel_trainingpeaks",
  },
  cycling: {
    ftpWatts: { value: 300, source: "manual", updatedAt: "2026-01-01T08:00:00.000Z" },
    powerZoneSystem: "coggan",
  },
  swimming: {
    thresholdPaceSecPer100m: { value: 90, source: "manual", updatedAt: "2026-01-01T08:00:00.000Z" },
    thresholdMethod: "css",
    poolLengthMeters: 25,
  },
});
