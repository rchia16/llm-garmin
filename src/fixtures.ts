import { athleteProfileSchema, workoutSchema, type AthleteProfile, type Workout } from "./domain/index.js";

// Small validated fixtures power the executable demo without involving natural-language parsing.
import { explicitRunningPace, thresholdRunningTarget } from "./engine/index.js";

const timestamps = {
  createdAt: "2026-01-01T08:00:00.000Z",
  updatedAt: "2026-01-01T08:00:00.000Z",
};

export const demoProfile: AthleteProfile = athleteProfileSchema.parse({
  id: "athlete-1",
  running: {
    thresholdPaceSecPerKm: { value: 265, source: "manual", updatedAt: timestamps.updatedAt },
    paceZoneSystem: "friel_trainingpeaks",
  },
  cycling: { powerZoneSystem: "coggan" },
  swimming: { thresholdMethod: "css" },
});

export const demoRunningThresholdWorkout: Workout = workoutSchema.parse({
  id: "demo-running-threshold",
  name: "5 x 1 km Threshold",
  sport: "running",
  ...timestamps,
  steps: [
    {
      id: "intervals",
      type: "repeat",
      repetitions: 5,
      steps: [
        { id: "work", type: "work", duration: { kind: "distance", metres: 1000 }, target: thresholdRunningTarget() },
        { id: "recovery", type: "recovery", duration: { kind: "time", seconds: 90 } },
      ],
    },
  ],
  resolutionWarnings: [],
});

export const demoRunningExplicitWorkout: Workout = workoutSchema.parse({
  id: "demo-running-explicit",
  name: "Explicit Pace",
  sport: "running",
  ...timestamps,
  steps: [{ id: "work", type: "work", duration: { kind: "distance", metres: 1000 }, target: explicitRunningPace(270) }],
  resolutionWarnings: [],
});
