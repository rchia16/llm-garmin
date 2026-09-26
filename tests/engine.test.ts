import { describe, expect, it } from "vitest";
import {
  paceStringToSecondsPerKm,
  paceToMetresPerSecond,
  recalculateWorkout,
  resolveFtpRange,
  resolveFtpFraction,
  resolveThresholdSpeedRange,
  resolveSwimmingOffset,
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

  it("resolves CSS offsets in either direction", () => {
    expect(resolveSwimmingOffset(90, 5)).toBe(95);
    expect(resolveSwimmingOffset(90, -2)).toBe(88);
    const result = resolveWorkoutTargets(swimmingWorkout, completeProfile).workout;
    expect(result.steps[0]?.target?.resolved).toMatchObject({ paceSecPer100m: 95 });
    expect(updateSwimmingThreshold(completeProfile, 87).swimming.thresholdPaceSecPer100m?.value).toBe(87);
    expect(recalculateWorkout(swimmingExplicitWorkout, updateSwimmingThreshold(completeProfile, 87)).steps[0]?.target?.resolved).toMatchObject({ paceSecPer100m: 95 });
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
