import { workoutSchema, type Workout } from "../../src/domain/index.js";
import {
  explicitCyclingWatts,
  explicitRunningPace,
  explicitSwimmingPace,
  ftpTarget,
  runningZoneTarget,
  swimmingThresholdOffset,
  thresholdRunningTarget,
} from "../../src/engine/index.js";

// These are structured canonical workouts, not parser fixtures; Phase 2 will add language inputs separately.

const timestamps = {
  createdAt: "2026-01-01T08:00:00.000Z",
  updatedAt: "2026-01-01T08:00:00.000Z",
};

export const runningThresholdWorkout: Workout = workoutSchema.parse({
  id: "running-threshold",
  name: "5 x 1 km Threshold",
  sport: "running",
  ...timestamps,
  steps: [
    { id: "warmup", type: "warmup", duration: { kind: "time", seconds: 600 } },
    {
      id: "intervals",
      type: "repeat",
      repetitions: 5,
      steps: [
        { id: "work", type: "work", duration: { kind: "distance", metres: 1000 }, target: thresholdRunningTarget() },
        { id: "recovery", type: "recovery", duration: { kind: "time", seconds: 90 } },
      ],
    },
    { id: "cooldown", type: "cooldown", duration: { kind: "time", seconds: 600 } },
  ],
  resolutionWarnings: [],
});

export const runningExplicitWorkout: Workout = workoutSchema.parse({
  id: "running-explicit",
  name: "5 x 1 km Explicit Pace",
  sport: "running",
  ...timestamps,
  steps: [{ id: "work", type: "work", duration: { kind: "distance", metres: 1000 }, target: explicitRunningPace(270) }],
  resolutionWarnings: [],
});

export const runningZ2Workout: Workout = workoutSchema.parse({
  id: "running-z2",
  name: "45 min Aerobic",
  sport: "running",
  ...timestamps,
  steps: [{ id: "aerobic", type: "work", duration: { kind: "time", seconds: 2700 }, target: runningZoneTarget("z2_aerobic") }],
  resolutionWarnings: [],
});

export const cyclingWorkout: Workout = workoutSchema.parse({
  id: "cycling-ftp",
  name: "3 x 10 min FTP",
  sport: "cycling",
  ...timestamps,
  steps: [{ id: "work", type: "work", duration: { kind: "time", seconds: 600 }, target: ftpTarget(1.05) }],
  resolutionWarnings: [],
});

export const cyclingZ2Workout: Workout = workoutSchema.parse({
  id: "cycling-z2",
  name: "90 min Endurance",
  sport: "cycling",
  ...timestamps,
  steps: [{ id: "endurance", type: "work", duration: { kind: "time", seconds: 5400 }, target: { sport: "cycling", prescriptionKind: "power_zone", source: "profile_derived", zoneSystem: "coggan", zone: "endurance" } }],
  resolutionWarnings: [],
});

export const cyclingExplicitWorkout: Workout = workoutSchema.parse({
  id: "cycling-explicit",
  name: "4 x 8 min Explicit Power",
  sport: "cycling",
  ...timestamps,
  steps: [{ id: "work", type: "work", duration: { kind: "time", seconds: 480 }, target: explicitCyclingWatts(300) }],
  resolutionWarnings: [],
});

export const swimmingWorkout: Workout = workoutSchema.parse({
  id: "swimming-css",
  name: "10 x 100 CSS + 5",
  sport: "swimming",
  ...timestamps,
  steps: [{ id: "work", type: "work", duration: { kind: "distance", metres: 100 }, target: swimmingThresholdOffset(5) }],
  resolutionWarnings: [],
});

export const swimmingExplicitWorkout: Workout = workoutSchema.parse({
  id: "swimming-explicit",
  name: "1000 m Explicit Pace",
  sport: "swimming",
  ...timestamps,
  steps: [{ id: "work", type: "work", duration: { kind: "distance", metres: 1000 }, target: explicitSwimmingPace(95) }],
  resolutionWarnings: [],
});
