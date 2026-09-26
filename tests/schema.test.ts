import { describe, expect, it } from "vitest";
import { athleteProfileSchema, workoutSchema } from "../src/domain/index.js";
import { emptyProfile } from "./fixtures/profiles.js";
import { runningThresholdWorkout } from "./fixtures/workouts.js";

// Schema tests protect the runtime contract used at application and persistence boundaries.

describe("domain schemas", () => {
  it("accepts canonical workouts and profiles", () => {
    expect(workoutSchema.parse(runningThresholdWorkout)).toEqual(runningThresholdWorkout);
    expect(athleteProfileSchema.parse(emptyProfile)).toEqual(emptyProfile);
  });

  it("rejects invalid profiles", () => {
    expect(() => athleteProfileSchema.parse({ ...emptyProfile, cycling: { powerZoneSystem: "unknown" } })).toThrow();
  });

  it("rejects unsupported sports and malformed durations", () => {
    expect(() => workoutSchema.parse({ ...runningThresholdWorkout, sport: "rowing" })).toThrow();
    expect(() => workoutSchema.parse({ ...runningThresholdWorkout, steps: [{ id: "bad", type: "work", duration: { kind: "time", seconds: 0 } }], resolutionWarnings: [] })).toThrow();
  });

  it("rejects invalid repeats and incomplete derived targets", () => {
    expect(() => workoutSchema.parse({ ...runningThresholdWorkout, steps: [{ id: "repeat", type: "repeat", repetitions: 0, steps: [] }], resolutionWarnings: [] })).toThrow();
    expect(() => workoutSchema.parse({ ...runningThresholdWorkout, steps: [{ id: "work", type: "work", duration: { kind: "distance", metres: 1000 }, target: { sport: "running", prescriptionKind: "explicit_pace", source: "explicit", paceSecPerKm: 270 } }], resolutionWarnings: [] })).toThrow();
    expect(() => workoutSchema.parse({ ...runningThresholdWorkout, steps: [{ id: "work", type: "work", duration: { kind: "distance", metres: 1000 }, target: { sport: "running", prescriptionKind: "pace_zone", source: "profile_derived", zoneSystem: "friel_trainingpeaks", zone: "unknown" } }], resolutionWarnings: [] })).toThrow();
  });
});
