import { describe, expect, it } from "vitest";
import type { WorkoutStep } from "../src/domain/index.js";
import { recalculateWorkout, updateCyclingFTP } from "../src/engine/index.js";
import { completeProfile } from "./fixtures/profiles.js";
import { cyclingWorkout } from "./fixtures/workouts.js";
import {
  addWorkoutStep,
  createWorkoutStep,
  defaultDurationForKind,
  editableTimeDuration,
  deleteWorkoutStep,
  moveWorkoutStep,
  preferredInsertionIndex,
  reclassifyWorkoutStep,
  retargetWorkoutStepsForSport,
  selectedZone,
  setWorkoutStepZone,
  stepTypeLabel,
  wrapWorkoutSteps,
  zoneChoices,
} from "../src/ui/workoutEditor.js";

const work: WorkoutStep = { id: "work", type: "work", duration: { kind: "distance", metres: 1000 } };

it("uses Rest wording for active recovery and passive rest", () => {
  expect(stepTypeLabel("recovery")).toBe("Rest");
  expect(stepTypeLabel("rest")).toBe("Rest");
  expect(stepTypeLabel("work")).toBe("work");
});
const cooldown: WorkoutStep = { id: "cooldown", type: "cooldown", duration: { kind: "time", seconds: 600 } };
const repeat: WorkoutStep = {
  id: "repeat",
  type: "repeat",
  repetitions: 4,
  steps: [
    { id: "repeat-work", type: "work", duration: { kind: "time", seconds: 180 } },
    { id: "repeat-recovery", type: "recovery", duration: { kind: "time", seconds: 60 } },
  ],
};

describe("workout review block editor", () => {
  it("sets valid sport-specific zones without changing other blocks or notes", () => {
    for (const [sport, zone] of [["running", "z2_aerobic"], ["cycling", "endurance"], ["swimming", "z5a_super_threshold"]] as const) {
      const original: WorkoutStep[] = [{ id: "group", type: "repeat", repetitions: 2, steps: [
        { id: "work", type: "work", duration: { kind: "time", seconds: 120 }, notes: "keep this" },
        { id: "rest", type: "rest", duration: { kind: "time", seconds: 30 } },
      ] }];
      expect(zoneChoices(sport).some((choice) => choice.value === zone)).toBe(true);
      const result = setWorkoutStepZone(original, "work", sport, zone);
      expect(result.changed).toBe(true);
      const group = result.steps[0];
      if (group?.type !== "repeat") throw new Error("Expected repeat group.");
      expect(group.steps[0]).toMatchObject({ type: "work", duration: { seconds: 120 }, notes: "keep this", target: { source: "profile_derived" } });
      expect(selectedZone(group.steps[0]?.type === "repeat" ? undefined : group.steps[0]?.target)).toBe(zone);
      expect(group.steps[1]?.type).toBe("rest");
      const originalGroup = original[0];
      if (originalGroup?.type !== "repeat") throw new Error("Expected original repeat group.");
      expect(originalGroup.steps[0]).not.toHaveProperty("target");
      expect(setWorkoutStepZone(original, "rest", sport, zone).changed).toBe(false);
      expect(setWorkoutStepZone(original, "work", sport, "invalid").changed).toBe(false);
    }
  });

  it("keeps a selected bike zone relative to FTP", () => {
    const original: WorkoutStep[] = [{ id: "work", type: "work", duration: { kind: "time", seconds: 600 }, target: { sport: "cycling", prescriptionKind: "explicit_watts", source: "explicit", watts: 250, resolved: { kind: "cycling_power", watts: 250 } } }];
    const changed = setWorkoutStepZone(original, "work", "cycling", "endurance");
    expect(changed.steps[0]?.target).toMatchObject({ prescriptionKind: "power_zone", zone: "endurance", source: "profile_derived" });
    const first = recalculateWorkout({ ...cyclingWorkout, steps: changed.steps }, completeProfile);
    const second = recalculateWorkout(first, updateCyclingFTP(completeProfile, 320));
    const firstTarget = first.steps[0]?.target?.resolved;
    const secondTarget = second.steps[0]?.target?.resolved;
    if (firstTarget?.kind !== "cycling_power" || secondTarget?.kind !== "cycling_power") throw new Error("Expected cycling power.");
    expect(firstTarget.rangeWatts?.[0]).toBeCloseTo(168);
    expect(secondTarget.rangeWatts?.[0]).toBeCloseTo(179.2);
    expect(original[0]?.target?.source).toBe("explicit");
  });

  it("reclassifies blocks in place without changing duration, target, notes, or nesting", () => {
    const warmup: WorkoutStep = { id: "warmup", type: "warmup", duration: { kind: "time", seconds: 720 }, notes: "easy", target: { sport: "cycling", prescriptionKind: "power_zone", source: "profile_derived", zoneSystem: "coggan", zone: "endurance" } };
    const nested: WorkoutStep = { id: "group", type: "repeat", repetitions: 3, steps: [warmup] };
    const original = [work, nested, cooldown];
    const changed = reclassifyWorkoutStep(original, "warmup", "work");
    expect(changed.changed).toBe(true);
    expect(changed.steps).toMatchObject([
      { id: "work", type: "work" },
      { id: "group", type: "repeat", repetitions: 3, steps: [{ id: "warmup", type: "work", duration: { seconds: 720 }, notes: "easy", target: { zone: "endurance" } }] },
      { id: "cooldown", type: "cooldown" },
    ]);
    expect(original[1]).toEqual(nested);
    expect(warmup.type).toBe("warmup");
    expect(reclassifyWorkoutStep(changed.steps, "work", "cooldown").steps[0]?.type).toBe("cooldown");
    expect(reclassifyWorkoutStep(changed.steps, "cooldown", "warmup").steps[2]?.type).toBe("warmup");
    expect(reclassifyWorkoutStep(original, "group", "work").changed).toBe(false);
    expect(reclassifyWorkoutStep([repeat], "repeat-recovery", "work").changed).toBe(false);
  });

  it("shows whole minutes as minutes and short or partial minutes as seconds", () => {
    expect(editableTimeDuration(600)).toEqual({ value: 10, unit: "min" });
    expect(editableTimeDuration(30)).toEqual({ value: 30, unit: "sec" });
    expect(editableTimeDuration(90)).toEqual({ value: 90, unit: "sec" });
  });

  it("reorders top-level blocks without mutating the input", () => {
    const original = [work, repeat, cooldown];
    const result = moveWorkoutStep(original, "cooldown", null, 0);

    expect(result.changed).toBe(true);
    expect(result.steps.map((step) => step.id)).toEqual(["cooldown", "work", "repeat"]);
    expect(original.map((step) => step.id)).toEqual(["work", "repeat", "cooldown"]);
  });

  it("moves a block into an existing repeat", () => {
    const result = moveWorkoutStep([work, repeat, cooldown], "cooldown", "repeat", 2);
    const movedRepeat = result.steps[1];

    expect(result.changed).toBe(true);
    expect(movedRepeat?.type).toBe("repeat");
    if (movedRepeat?.type === "repeat") {
      expect(movedRepeat.steps.map((step) => step.id)).toEqual(["repeat-work", "repeat-recovery", "cooldown"]);
    }
  });

  it("prevents self-nesting and empty repeat groups", () => {
    const selfNested = moveWorkoutStep([work, repeat], "repeat", "repeat", 0);
    expect(selfNested.changed).toBe(false);

    const singleChildRepeat: WorkoutStep = { id: "single", type: "repeat", repetitions: 2, steps: [work] };
    const emptied = moveWorkoutStep([singleChildRepeat, cooldown], "work", null, 1);
    expect(emptied.changed).toBe(false);
    expect(emptied.reason).toContain("at least one block");
  });

  it("adds useful sport-specific defaults and protects the last block", () => {
    let id = 0;
    const createdRepeat = createWorkoutStep("repeat", "running", () => `new-${++id}`);
    const added = addWorkoutStep([work], null, createdRepeat);

    expect(added.changed).toBe(true);
    expect(createdRepeat.type).toBe("repeat");
    if (createdRepeat.type === "repeat") {
      expect(createdRepeat.steps).toHaveLength(2);
      expect(createdRepeat.steps[0]).toMatchObject({ type: "work", duration: { kind: "distance", metres: 1000 } });
    }
    expect(deleteWorkoutStep([work], "work").changed).toBe(false);
  });

  it("places new blocks according to workout semantics", () => {
    const steps = [work, cooldown];
    const warmup: WorkoutStep = { id: "warmup", type: "warmup", duration: { kind: "time", seconds: 600 } };
    const secondWork: WorkoutStep = { id: "work-2", type: "work", duration: { kind: "distance", metres: 800 } };

    const withWarmup = addWorkoutStep(steps, null, warmup, preferredInsertionIndex(steps, null, "warmup"));
    expect(withWarmup.steps.map((step) => step.id)).toEqual(["warmup", "work", "cooldown"]);

    const withWork = addWorkoutStep(steps, null, secondWork, preferredInsertionIndex(steps, null, "work"));
    expect(withWork.steps.map((step) => step.id)).toEqual(["work", "work-2", "cooldown"]);

    const noCooldown = [work, repeat];
    expect(preferredInsertionIndex(noCooldown, null, "work")).toBe(2);
    expect(preferredInsertionIndex(noCooldown, null, "cooldown")).toBe(2);
  });

  it("wraps adjacent selected blocks in a repeat at their current position", () => {
    const warmup: WorkoutStep = { id: "warmup", type: "warmup", duration: { kind: "time", seconds: 600 } };
    const recovery: WorkoutStep = { id: "recovery", type: "recovery", duration: { kind: "time", seconds: 60 } };
    const result = wrapWorkoutSteps([warmup, work, recovery, cooldown], ["work", "recovery"], "wrapped");

    expect(result.changed).toBe(true);
    expect(result.steps.map((step) => step.id)).toEqual(["warmup", "wrapped", "cooldown"]);
    const wrapped = result.steps[1];
    expect(wrapped?.type).toBe("repeat");
    if (wrapped?.type === "repeat") expect(wrapped.steps.map((step) => step.id)).toEqual(["work", "recovery"]);

    const disjoint = wrapWorkoutSteps([warmup, work, recovery, cooldown], ["warmup", "recovery"], "invalid");
    expect(disjoint.changed).toBe(false);
    expect(disjoint.reason).toContain("adjacent");
  });

  it("replaces incompatible targets when switching between run, ride, and swim", () => {
    const runningTargeted: WorkoutStep[] = [
      { ...work, target: { sport: "running", prescriptionKind: "explicit_pace", source: "explicit", paceSecPerKm: 270, resolved: { kind: "running_pace", paceSecPerKm: 270 } } },
      repeat,
      cooldown,
    ];

    const cycling = retargetWorkoutStepsForSport(runningTargeted, "cycling");
    expect(cycling[0]?.target).toMatchObject({ sport: "cycling", prescriptionKind: "ftp_fraction", fraction: 1 });
    const cyclingRepeat = cycling[1];
    if (cyclingRepeat?.type !== "repeat") throw new Error("Expected repeat group.");
    expect(cyclingRepeat.steps[1]?.target).toMatchObject({ sport: "cycling", prescriptionKind: "power_zone", zone: "recovery" });

    const swimming = retargetWorkoutStepsForSport(runningTargeted, "swimming");
    expect(swimming[0]?.target).toMatchObject({ sport: "swimming", prescriptionKind: "threshold_offset", offsetSecPer100m: 0 });
    expect(swimming[2]?.target).toBeUndefined();
  });

  it("supports time and distance durations for every sport", () => {
    for (const sport of ["running", "cycling", "swimming"] as const) {
      expect(defaultDurationForKind("time", "work", sport)).toMatchObject({ kind: "time" });
      expect(defaultDurationForKind("distance", "work", sport)).toMatchObject({ kind: "distance" });
    }
    expect(defaultDurationForKind("distance", "work", "swimming")).toEqual({ kind: "distance", metres: 100 });
    expect(defaultDurationForKind("distance", "work", "cycling")).toEqual({ kind: "distance", metres: 1000 });
  });
});
