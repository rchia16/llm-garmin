import { describe, expect, it } from "vitest";
import { summarizeWorkout } from "../src/engine/workoutSummary.js";
import { explicitRunningPace, explicitSwimmingPace } from "../src/engine/index.js";
import type { WorkoutStep } from "../src/domain/index.js";

describe("planned workout totals", () => {
  it("expands nested repeats and converts resolved distance and time targets", () => {
    const steps: WorkoutStep[] = [
      { id: "warmup", type: "warmup", duration: { kind: "time", seconds: 600 }, target: explicitRunningPace(300) },
      { id: "outer", type: "repeat", repetitions: 2, steps: [
        { id: "inner", type: "repeat", repetitions: 3, steps: [
          { id: "work", type: "work", duration: { kind: "distance", metres: 1000 }, target: explicitRunningPace(240) },
          { id: "rest", type: "rest", duration: { kind: "time", seconds: 30 } },
        ] },
      ] },
    ];
    expect(summarizeWorkout(steps, "running")).toEqual({
      knownTimeSeconds: 2220,
      knownDistanceMetres: 8000,
      timeComplete: true,
      distanceComplete: true,
      timeEstimated: true,
      distanceEstimated: true,
      recoverySeconds: 180,
      recoveryComplete: true,
    });
  });

  it("does not derive cycling distance from watts or time trials from unknown pace", () => {
    const bike: WorkoutStep[] = [
      { id: "bike", type: "work", duration: { kind: "time", seconds: 1200 } },
      { id: "recovery", type: "recovery", duration: { kind: "time", seconds: 120 } },
    ];
    expect(summarizeWorkout(bike, "cycling")).toMatchObject({
      knownTimeSeconds: 1320, knownDistanceMetres: 0, timeComplete: true, distanceComplete: false, recoverySeconds: 120,
    });

    const swim: WorkoutStep[] = [
      { id: "trial", type: "work", duration: { kind: "distance", metres: 400 }, notes: "FS maximal effort time trial RECORD TIME" },
      { id: "easy", type: "work", duration: { kind: "distance", metres: 100 }, target: explicitSwimmingPace(100) },
      { id: "open", type: "rest", duration: { kind: "open" } },
    ];
    expect(summarizeWorkout(swim, "swimming")).toMatchObject({
      knownTimeSeconds: 100, knownDistanceMetres: 500, timeComplete: false, distanceComplete: true, recoveryComplete: false,
    });
  });
});
