import { describe, expect, it } from "vitest";
import { workoutSchema } from "../src/domain/index.js";
import { resolveWorkoutTargets, swimmingZoneTarget } from "../src/engine/index.js";
import { exportGarminConnectJson } from "../src/garminConnectJson/export.js";
import { completeProfile, emptyProfile } from "./fixtures/profiles.js";
import { cyclingExplicitWorkout, cyclingZ2Workout, runningThresholdWorkout, swimmingWorkout } from "./fixtures/workouts.js";

type JsonStep = Record<string, unknown> & { workoutSteps?: JsonStep[] };

function exportedSteps(exported: ReturnType<typeof exportGarminConnectJson>): JsonStep[] {
  const segments = exported.workout.workoutSegments as { workoutSteps: JsonStep[] }[];
  return segments[0]?.workoutSteps ?? [];
}

describe("Garmin Connect JSON export", () => {
  it("preserves run step order, nested repeats, distances, time, and resolved pace speeds", () => {
    const workout = resolveWorkoutTargets(runningThresholdWorkout, completeProfile).workout;
    const exported = exportGarminConnectJson(workout);
    const parsed = JSON.parse(JSON.stringify(exported.workout)) as Record<string, unknown>;
    expect(parsed).toMatchObject({ workoutName: workout.name, sportType: { sportTypeId: 1, sportTypeKey: "running" } });
    expect(parsed).not.toHaveProperty("workoutId");
    const [warmup, repeat, cooldown] = exportedSteps(exported);
    expect(warmup).toMatchObject({ type: "ExecutableStepDTO", stepId: null, stepOrder: 1, stepType: { stepTypeKey: "warmup" }, endCondition: { conditionTypeKey: "time" }, endConditionValue: 600 });
    expect(repeat).toMatchObject({ type: "RepeatGroupDTO", stepId: null, stepOrder: 2, numberOfIterations: 5, endCondition: { conditionTypeKey: "iterations" } });
    const [work, recovery] = repeat?.workoutSteps ?? [];
    expect(work).toMatchObject({ stepOrder: 3, stepType: { stepTypeKey: "interval" }, endCondition: { conditionTypeKey: "distance" }, endConditionValue: 1000, targetType: { workoutTargetTypeKey: "pace.zone" } });
    expect(work?.targetValueOne).toBeCloseTo(1000 / 265);
    expect(recovery).toMatchObject({ stepOrder: 4, stepType: { stepTypeKey: "recovery" }, endConditionValue: 90 });
    expect(cooldown).toMatchObject({ stepOrder: 5, stepType: { stepTypeKey: "cooldown" } });
    expect(exported.warnings).toEqual([]);
  });

  it("uses a Garmin power zone for a Coggan bike zone and warns about custom watts", () => {
    const zone = exportGarminConnectJson(resolveWorkoutTargets(cyclingZ2Workout, completeProfile).workout);
    expect(exportedSteps(zone)[0]).toMatchObject({ targetType: { workoutTargetTypeKey: "power.zone" }, zoneNumber: 2 });
    expect(zone.warnings).toEqual([]);
    const watts = exportGarminConnectJson(cyclingExplicitWorkout);
    expect(exportedSteps(watts)[0]).toMatchObject({ targetType: { workoutTargetTypeKey: "power.zone" }, targetValueOne: 300, targetValueTwo: 300 });
    expect(watts.warnings).toEqual([expect.stringContaining("verify custom watt targets")]);
  });

  it("exports swim stroke and pace separately, preserves rest in a repeat, and leaves tests untargeted", () => {
    const workout = workoutSchema.parse({
      ...swimmingWorkout,
      steps: [
        { id: "repeat", type: "repeat", repetitions: 2, steps: [
          { id: "pull", type: "work", duration: { kind: "distance", metres: 100 }, target: swimmingZoneTarget("z2_aerobic"), notes: "FS Pull" },
          { id: "rest", type: "rest", duration: { kind: "time", seconds: 15 } },
        ] },
        { id: "test", type: "work", duration: { kind: "distance", metres: 400 }, notes: "FS maximal effort time trial; RECORD TIME" },
      ],
    });
    const exported = exportGarminConnectJson(resolveWorkoutTargets(workout, completeProfile).workout, completeProfile);
    expect(exported.workout).toMatchObject({ sportType: { sportTypeId: 4, sportTypeKey: "swimming" }, poolLength: 25, poolLengthUnit: { unitKey: "meter" } });
    const [repeat, test] = exportedSteps(exported);
    expect(repeat).toMatchObject({ type: "RepeatGroupDTO", numberOfIterations: 2 });
    const [pull, rest] = repeat?.workoutSteps ?? [];
    expect(pull).toMatchObject({ stepType: { stepTypeKey: "main" }, strokeType: { strokeTypeKey: "free" }, targetType: { workoutTargetTypeKey: "no.target" }, secondaryTargetType: { workoutTargetTypeKey: "pace.zone" }, endConditionValue: 100, description: "FS Pull" });
    expect(pull?.secondaryTargetValueOne).toBeCloseTo(100 / (90 * 1.14));
    expect(rest).toMatchObject({ stepType: { stepTypeKey: "rest" }, endConditionValue: 15, targetType: { workoutTargetTypeKey: "no.target" } });
    expect(test).toMatchObject({ targetType: { workoutTargetTypeKey: "no.target" }, description: expect.stringContaining("RECORD TIME") });
    expect(test).not.toHaveProperty("secondaryTargetType");
    expect(exported.warnings).toEqual([expect.stringContaining("Swim pace is exported as a secondary target")]);
  });

  it("refuses unresolved profile-derived targets without altering the workout", () => {
    const workout = resolveWorkoutTargets(swimmingWorkout, emptyProfile).workout;
    expect(() => exportGarminConnectJson(workout)).toThrow(/needs a profile baseline/);
    expect(workout.steps[0]?.target?.resolved).toBeUndefined();
  });
});
