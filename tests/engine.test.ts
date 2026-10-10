import { describe, expect, it } from "vitest";
import { workoutSchema } from "../src/domain/index.js";
import {
  cyclingZoneTarget,
  explicitCyclingWatts,
  paceStringToSecondsPerKm,
  paceToMetresPerSecond,
  recalculateWorkout,
  resolveFtpRange,
  resolveFtpFraction,
  resolveCyclingZone,
  resolveThresholdSpeedRange,
  resolveSwimmingOffset,
  resolveSwimmingZone,
  resolveWorkoutTargets,
  secondsPerKmToPaceString,
  updateCyclingFTP,
  updateRunningThreshold,
  updateSwimmingThreshold,
} from "../src/engine/index.js";
import { completeProfile, emptyProfile } from "./fixtures/profiles.js";
import { cyclingExplicitWorkout, cyclingWorkout, runningExplicitWorkout, runningThresholdWorkout, swimmingExplicitWorkout, swimmingWorkout } from "./fixtures/workouts.js";

// Engine tests focus on deterministic values and the explicit-versus-derived target contract.

describe("running calculations", () => {
  it("converts pace and speed consistently", () => {
    expect(paceStringToSecondsPerKm("4:30/km")).toBe(270);
    expect(secondsPerKmToPaceString(288.9)).toBe("4:49/km");
    expect(paceToMetresPerSecond(270)).toBeCloseTo(3.7037, 4);
    expect(resolveThresholdSpeedRange(270, [0.8, 0.9])).toEqual([300, 337.5]);
  });

  it("resolves and recalculates threshold targets in speed space", () => {
    const first = resolveWorkoutTargets(runningThresholdWorkout, completeProfile).workout;
    const firstTarget = first.steps[1];
    expect(firstTarget?.type).toBe("repeat");
    if (firstTarget?.type !== "repeat") return;
    expect(firstTarget.steps[0]?.target?.resolved).toMatchObject({ paceSecPerKm: 265 });
    const fasterProfile = updateRunningThreshold(completeProfile, 258, { updatedAt: "2026-01-02T08:00:00.000Z" });
    const second = recalculateWorkout(first, fasterProfile);
    const secondTarget = second.steps[1];
    if (secondTarget?.type !== "repeat") return;
    expect(secondTarget.steps[0]?.target?.resolved).toMatchObject({ paceSecPerKm: 258 });
  });

  it("preserves explicit running pace by default", () => {
    const result = recalculateWorkout(runningExplicitWorkout, updateRunningThreshold(completeProfile, 258));
    expect(result.steps[0]?.target?.resolved).toMatchObject({ paceSecPerKm: 270 });
  });
});

describe("cycling and swimming calculations", () => {
  it("resolves FTP fractions and updates them", () => {
    expect(resolveFtpFraction(300, 1.05)).toBe(315);
    expect(resolveFtpRange(300, [0.8, 0.9])).toEqual([240, 270]);
    const result = resolveWorkoutTargets(cyclingWorkout, completeProfile).workout;
    expect(result.steps[0]?.target?.resolved).toMatchObject({ watts: 315 });
    expect(updateCyclingFTP(completeProfile, 310).cycling.ftpWatts?.value).toBe(310);
    expect(recalculateWorkout(cyclingExplicitWorkout, updateCyclingFTP(completeProfile, 310)).steps[0]?.target?.resolved).toMatchObject({ watts: 300 });
  });

  it("resolves zero-based recovery ranges and recalculates bike zones after FTP changes", () => {
    expect(resolveFtpRange(300, [0, 0.55])).toEqual([0, 165]);
    expect(resolveCyclingZone(300, "recovery")).toEqual({ watts: 165, rangeWatts: [0, 165] });
    expect(() => resolveFtpRange(300, [-0.1, 0.55])).toThrow();
    expect(() => resolveFtpRange(300, [0.55, 0])).toThrow();

    const workout = workoutSchema.parse({
      ...cyclingWorkout,
      steps: [
        { id: "recovery", type: "recovery", duration: { kind: "time", seconds: 120 }, target: cyclingZoneTarget("recovery") },
        { id: "endurance", type: "work", duration: { kind: "time", seconds: 600 }, target: cyclingZoneTarget("endurance") },
        { id: "explicit", type: "work", duration: { kind: "time", seconds: 60 }, target: explicitCyclingWatts(200) },
      ],
    });
    const first = resolveWorkoutTargets(workout, completeProfile).workout;
    expect(workoutSchema.parse(first).steps[0]?.target?.resolved).toEqual({ kind: "cycling_power", watts: 165, rangeWatts: [0, 165] });

    const changed = recalculateWorkout(first, updateCyclingFTP(completeProfile, 320));
    expect(changed.steps[0]?.target?.resolved).toEqual({ kind: "cycling_power", watts: 176, rangeWatts: [0, 176] });
    const endurance = changed.steps[1]?.target?.resolved;
    if (endurance?.kind !== "cycling_power") throw new Error("Expected resolved cycling power.");
    expect(endurance.watts).toBeCloseTo(179.2);
    expect(endurance.rangeWatts?.[1]).toBe(240);
    expect(changed.steps[2]?.target?.resolved).toEqual({ kind: "cycling_power", watts: 200 });
  });

  it("resolves CSS offsets in either direction", () => {
    expect(resolveSwimmingOffset(90, 5)).toBe(95);
    expect(resolveSwimmingOffset(90, -2)).toBe(88);
    const result = resolveWorkoutTargets(swimmingWorkout, completeProfile).workout;
    expect(result.steps[0]?.target?.resolved).toMatchObject({ paceSecPer100m: 95 });
    expect(updateSwimmingThreshold(completeProfile, 87).swimming.thresholdPaceSecPer100m?.value).toBe(87);
    expect(recalculateWorkout(swimmingExplicitWorkout, updateSwimmingThreshold(completeProfile, 87)).steps[0]?.target?.resolved).toMatchObject({ paceSecPer100m: 95 });
  });

  it("uses TrainingPeaks Joe Friel swimming pace-zone boundaries", () => {
    expect(resolveSwimmingZone(100, "z2_aerobic")).toEqual({
      paceSecPer100m: 114,
      rangePaceSecPer100m: [114, 129],
    });
    expect(resolveSwimmingZone(100, "z4_threshold")).toEqual({
      paceSecPer100m: 101,
      rangePaceSecPer100m: [101, 105],
    });
    expect(resolveSwimmingZone(100, "z5a_super_threshold")).toEqual({
      paceSecPer100m: 97,
      rangePaceSecPer100m: [97, 100],
    });
    expect(resolveSwimmingZone(100, "z1_recovery")).toEqual({ paceSecPer100m: 130 });
    expect(resolveSwimmingZone(100, "z5c_power")).toEqual({ paceSecPer100m: 89 });
  });

  it("supports deliberate compatible explicit rescaling", () => {
    const previous = completeProfile;
    const current = updateRunningThreshold(previous, 258);
    const result = recalculateWorkout(runningExplicitWorkout, current, "allCompatibleTargets", previous);
    expect(result.steps[0]?.target?.resolved).toMatchObject({ paceSecPerKm: 270 * 258 / 265 });
  });
});

describe("missing baselines", () => {
  it("reports unresolved requirements without inventing targets", () => {
    const result = resolveWorkoutTargets(runningThresholdWorkout, emptyProfile);
    expect(result.warnings[0]?.code).toBe("RUNNING_THRESHOLD_PACE_REQUIRED");
    const repeat = result.workout.steps[1];
    if (repeat?.type !== "repeat") return;
    expect(repeat.steps[0]?.target?.resolved).toBeUndefined();
  });
});
