import { Decoder, Stream } from "@garmin/fitsdk";
import { describe, expect, it } from "vitest";
import { workoutSchema } from "../src/domain/index.js";
import { cyclingZoneTarget, ftpTarget, resolveWorkoutTargets, runningZoneTarget, swimmingZoneTarget } from "../src/engine/index.js";
import { compileFitSteps, exportFitWorkout } from "../src/fit/export.js";
import { completeProfile, emptyProfile } from "./fixtures/profiles.js";
import { cyclingWorkout, runningThresholdWorkout, swimmingWorkout } from "./fixtures/workouts.js";

function decode(bytes: Uint8Array) {
  const decoder = new Decoder(Stream.fromByteArray(bytes));
  expect(decoder.checkIntegrity()).toBe(true);
  const result = decoder.read();
  expect(result.errors).toEqual([]);
  return result.messages;
}

describe("FIT workout export", () => {
  it("round-trips running distance, time, targets, and repeat back-references", () => {
    const workout = resolveWorkoutTargets(runningThresholdWorkout, completeProfile).workout;
    const compiled = compileFitSteps(workout);
    const messages = decode(exportFitWorkout(workout).bytes);
    expect(messages.fileIdMesgs?.[0]?.type).toBe("workout");
    expect(messages.workoutMesgs?.[0]).toMatchObject({ sport: "running", numValidSteps: compiled.steps.length });
    const steps = messages.workoutStepMesgs ?? [];
    expect(steps).toHaveLength(compiled.steps.length);
    expect(steps.map((step) => step.messageIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(steps[0]).toMatchObject({ durationType: "time", durationTime: 600, intensity: "warmup" });
    expect(steps[1]).toMatchObject({ durationType: "distance", durationDistance: 1000, targetType: "speed" });
    expect(steps[2]).toMatchObject({ durationType: "time", durationTime: 90, intensity: "recovery" });
    expect(steps[3]).toMatchObject({ durationType: "repeatUntilStepsCmplt", durationStep: 1, repeatSteps: 5 });
    expect(steps[4]).toMatchObject({ intensity: "cooldown" });
  });

  it("round-trips bike power targets including zero-based recovery", () => {
    const workout = resolveWorkoutTargets(workoutSchema.parse({
      ...cyclingWorkout,
      steps: [{ id: "repeat", type: "repeat", repetitions: 3, steps: [
        { id: "work", type: "work", duration: { kind: "time", seconds: 360 }, target: ftpTarget(1.05) },
        { id: "recovery", type: "recovery", duration: { kind: "time", seconds: 180 }, target: cyclingZoneTarget("recovery") },
      ] }],
    }), completeProfile).workout;
    const steps = decode(exportFitWorkout(workout).bytes).workoutStepMesgs ?? [];
    expect(steps[0]).toMatchObject({ targetType: "power", customTargetPowerLow: 1315, customTargetPowerHigh: 1315 });
    expect(steps[1]).toMatchObject({ targetType: "power", customTargetValueLow: 1000, customTargetPowerHigh: 1165 });
    expect(steps[2]).toMatchObject({ durationType: "repeatUntilStepsCmplt", durationStep: 0, repeatSteps: 3 });
  });

  it("keeps swim stroke and notes, and discloses pace as a cue", () => {
    const workout = resolveWorkoutTargets(workoutSchema.parse({
      ...swimmingWorkout,
      steps: [{ id: "pull", type: "work", duration: { kind: "distance", metres: 100 }, target: swimmingZoneTarget("z4_threshold"), notes: "Pull" }],
    }), completeProfile).workout;
    const exported = exportFitWorkout(workout);
    const messages = decode(exported.bytes);
    expect(messages.workoutMesgs?.[0]).toMatchObject({ sport: "swimming", subSport: "lapSwimming" });
    expect(messages.workoutStepMesgs?.[0]).toMatchObject({ durationDistance: 100, targetType: "swimStroke", targetStrokeType: "freestyle" });
    expect(messages.workoutStepMesgs?.[0]?.notes).toContain("Pull");
    expect(exported.warnings).toHaveLength(1);
  });

  it("encodes either duration kind for ride and swim", () => {
    const ride = workoutSchema.parse({
      ...cyclingWorkout,
      steps: [{ id: "distance", type: "work", duration: { kind: "distance", metres: 5000 } }],
    });
    const swim = workoutSchema.parse({
      ...swimmingWorkout,
      steps: [{ id: "timed", type: "work", duration: { kind: "time", seconds: 75 }, notes: "drill" }],
    });
    expect(decode(exportFitWorkout(ride).bytes).workoutStepMesgs?.[0]).toMatchObject({ durationType: "distance", durationDistance: 5000 });
    expect(decode(exportFitWorkout(swim).bytes).workoutStepMesgs?.[0]).toMatchObject({ durationType: "time", durationTime: 75, targetStrokeType: "drill" });
  });

  it("handles nested repeats and refuses unresolved targets", () => {
    const workout = resolveWorkoutTargets(workoutSchema.parse({
      ...runningThresholdWorkout,
      steps: [{ id: "outer", type: "repeat", repetitions: 2, steps: [
        { id: "inner", type: "repeat", repetitions: 3, steps: [
          { id: "work", type: "work", duration: { kind: "time", seconds: 60 }, target: runningZoneTarget("z4_threshold") },
        ] },
        { id: "easy", type: "recovery", duration: { kind: "time", seconds: 30 } },
      ] }],
    }), completeProfile).workout;
    const steps = decode(exportFitWorkout(workout).bytes).workoutStepMesgs ?? [];
    expect(steps[1]).toMatchObject({ durationStep: 0, repeatSteps: 3 });
    expect(steps[3]).toMatchObject({ durationStep: 0, repeatSteps: 2 });
    expect(() => exportFitWorkout(resolveWorkoutTargets(runningThresholdWorkout, emptyProfile).workout)).toThrow("needs a profile baseline");
    expect(() => exportFitWorkout(workoutSchema.parse({
      ...cyclingWorkout,
      steps: [{ id: "wrong-sport", type: "work", duration: { kind: "time", seconds: 60 }, target: runningZoneTarget("z2_aerobic") }],
    }))).toThrow("running target in a cycling workout");
  });
});
