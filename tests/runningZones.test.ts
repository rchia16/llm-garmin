import { describe, expect, it, vi } from "vitest";
import { Decoder, Stream } from "@garmin/fitsdk";
import { runningTargetSchema, workoutSchema } from "../src/domain/index.js";
import { recalculateWorkout, resolveRunningZone, resolveWorkoutTargets, runningPaceLabel, runningZoneTarget, updateRunningThreshold } from "../src/engine/index.js";
import { parseWorkout } from "../src/llm/parser.js";
import { parsedWorkoutSchema } from "../src/llm/schema.js";
import { runningEffortZone } from "../src/llm/runningEffort.js";
import { zoneChoices } from "../src/ui/workoutEditor.js";
import { exportFitWorkout } from "../src/fit/export.js";
import { exportGarminConnectJson } from "../src/garminConnectJson/export.js";
import { summarizeWorkout } from "../src/engine/workoutSummary.js";
import { completeProfile } from "./fixtures/profiles.js";
import { runningThresholdWorkout } from "./fixtures/workouts.js";

const options = { profile: completeProfile, selectedSport: "running" as const, referenceDate: "2026-10-10", timeZone: "Australia/Sydney" };

describe("seven-zone Friel running pace", () => {
  it.each([
    ["z2_aerobic", 342, 387], ["z3_tempo", 318, 339], ["z4_threshold", 297, 315],
    ["z5a_super_threshold", 291, 300], ["z5b_aerobic_capacity", 270, 288],
  ] as const)("resolves published %s pace boundaries", (zone, fast, slow) => {
    expect(resolveRunningZone(300, zone)).toEqual({ paceSecPerKm: fast, rangePaceSecPerKm: [fast, slow] });
  });

  it("retains one-sided Z1/Z5c and the plain Z5 family", () => {
    expect(resolveRunningZone(300, "z1_recovery")).toEqual({ paceSecPerKm: 387, paceBoundary: "slower_than" });
    expect(resolveRunningZone(300, "z5c_anaerobic_capacity")).toEqual({ paceSecPerKm: 270, paceBoundary: "faster_than" });
    expect(resolveRunningZone(300, "z5_aggregate")).toEqual({ paceSecPerKm: 300, paceBoundary: "at_or_faster_than" });
    expect(runningPaceLabel({ kind: "running_pace", ...resolveRunningZone(300, "z5c_anaerobic_capacity") })).toBe("<4:30/km");
    expect(runningPaceLabel({ kind: "running_pace", ...resolveRunningZone(300, "z5a_super_threshold") })).toBe("4:51–5:00/km");
    for (const baseline of [0, -1, Infinity, NaN]) expect(() => resolveRunningZone(baseline, "z5a_super_threshold")).toThrow();
  });

  it("loads the old Z5 target as the family and recalculates it without choosing a subzone", () => {
    const oldTarget = runningTargetSchema.parse({ sport: "running", prescriptionKind: "pace_zone", source: "profile_derived", zoneSystem: "friel_trainingpeaks", zone: "z5_anaerobic" });
    expect(oldTarget).toMatchObject({ zone: "z5_aggregate" });
    const workout = workoutSchema.parse({ ...runningThresholdWorkout, steps: [{ id: "old", type: "work", duration: { kind: "time", seconds: 60 }, target: oldTarget }] });
    expect(recalculateWorkout(workout, updateRunningThreshold(completeProfile, 300)).steps[0]?.target?.resolved).toMatchObject({ paceSecPerKm: 300, paceBoundary: "at_or_faster_than" });
  });

  it("offers all seven zones plus plain Z5 in the editor", () => {
    expect(zoneChoices("running").map((choice) => choice.value)).toEqual([
      "z1_recovery", "z2_aerobic", "z3_tempo", "z4_threshold", "z5_aggregate", "z5a_super_threshold", "z5b_aerobic_capacity", "z5c_anaerobic_capacity",
    ]);
  });

  it.each([ ["Z5a", "z5a_super_threshold"], ["5b", "z5b_aerobic_capacity"], ["zone 5C", "z5c_anaerobic_capacity"], ["z5_anaerobic", "z5_aggregate"] ])("normalises model alias %s", (alias, zone) => {
    const parsed = parsedWorkoutSchema.parse({ name: "Alias run", sport: "running", scheduledDate: null, profileUpdates: [], steps: [
      { id: "work", type: "work", duration: { kind: "time", seconds: 60 }, target: { kind: "running_zone", zone: alias } },
    ] });
    expect(parsed.steps[0]?.target).toMatchObject({ zone });
  });

  it("routes explicit subzones through the deterministic parser without losing repeat groups", async () => {
    const generateStructured = vi.fn(async () => { throw new Error("No model call"); });
    const result = await parseWorkout({ ...options, provider: { generateStructured }, sourcePrompt: `Warm Up:
10 mins in Z2.
Main Set:
2 x (90 secs in Z5a + 90 secs recoveries in Z2),
4 x (30 secs in Z5B + 30 secs recoveries in Z2),
4 x (15 secs in Z5c + 15 secs recoveries in Z1).
Warm Down:
5 mins in Z1.` });
    expect(generateStructured).not.toHaveBeenCalled();
    expect(result.workout.steps.slice(1, 4).map((step) => step.type === "repeat" ? step.steps[0]?.target : undefined)).toMatchObject([
      { zone: "z5a_super_threshold" }, { zone: "z5b_aerobic_capacity" }, { zone: "z5c_anaerobic_capacity" },
    ]);
    expect(result.interpretationWarnings).toEqual([]);
  });

  it.each([
    ["Hard", 120, "z5a_super_threshold"], ["Hard", 121, "z4_threshold"],
    ["Very Hard", 60, "z5b_aerobic_capacity"], ["Very Hard", 61, "z5a_super_threshold"],
    ["Sprint", 30, "z5c_anaerobic_capacity"], ["Sprint", 31, undefined],
    ["maximal effort time trial", 15, undefined], ["float recovery", 90, "z2_aerobic"],
    ["Stride: fast relaxed", 20, undefined], ["Hard; Target unspecified", 60, undefined],
  ] as const)("maps %s over %s seconds to %s", (wording, seconds, zone) => {
    expect(runningEffortZone(wording, { kind: "time", seconds })).toBe(zone);
  });

  it("uses reviewable seven-zone Mona defaults without inference and updates them with threshold", async () => {
    const generateStructured = vi.fn(async () => { throw new Error("No model call"); });
    const result = await parseWorkout({ ...options, provider: { generateStructured }, sourcePrompt: "Mona Fartlek" });
    expect(generateStructured).not.toHaveBeenCalled();
    const updated = recalculateWorkout(result.workout, updateRunningThreshold(result.profile, 300));
    expect(updated.steps.map((step) => step.type === "repeat" ? step.steps[0]?.target?.resolved : undefined)).toMatchObject([
      { paceSecPerKm: 291, rangePaceSecPerKm: [291, 300] }, { paceSecPerKm: 291, rangePaceSecPerKm: [291, 300] },
      { paceSecPerKm: 270, rangePaceSecPerKm: [270, 288] }, { paceSecPerKm: 270, paceBoundary: "faster_than" },
    ]);
    expect(updated.steps.map((step) => step.type === "repeat" && step.steps[0]?.target?.prescriptionKind === "pace_zone" ? step.steps[0].target.zone : undefined))
      .toEqual(["z5a_super_threshold", "z5a_super_threshold", "z5b_aerobic_capacity", "z5c_anaerobic_capacity"]);
    expect(updated.steps.every((step) => step.type === "repeat" && step.steps[1]?.target?.prescriptionKind === "pace_zone" && step.steps[1].target.zone === "z2_aerobic")).toBe(true);
  });

  it("exports bounded subzones as speeds and preserves unbounded targets as notes", () => {
    const workout = resolveWorkoutTargets(workoutSchema.parse({ ...runningThresholdWorkout, steps: [
      { id: "bounded", type: "work", duration: { kind: "time", seconds: 60 }, target: runningZoneTarget("z5b_aerobic_capacity") },
      { id: "unbounded", type: "work", duration: { kind: "time", seconds: 15 }, target: runningZoneTarget("z5c_anaerobic_capacity"), notes: "Sprint" },
    ] }), updateRunningThreshold(completeProfile, 300)).workout;
    const fit = exportFitWorkout(workout);
    const decoded = new Decoder(Stream.fromByteArray(fit.bytes)).read();
    expect(decoded.errors).toEqual([]);
    expect(decoded.messages.workoutStepMesgs?.[0]).toMatchObject({ targetType: "speed" });
    expect(decoded.messages.workoutStepMesgs?.[1]).toMatchObject({ targetType: "open", notes: "Sprint; Running pace <4:30/km" });
    expect(fit.warnings).toHaveLength(1);
    const json = exportGarminConnectJson(workout);
    expect(json.workout).toMatchObject({ workoutSegments: [{ workoutSteps: [
      { targetValueOne: 1000 / 270, targetValueTwo: 1000 / 288 },
      { targetType: { workoutTargetTypeKey: "no.target" }, description: "Sprint; Running pace <4:30/km" },
    ] }] });
    expect(json.warnings).toHaveLength(1);
    const summary = summarizeWorkout([workout.steps[1]!], "running");
    expect(summary.distanceComplete).toBe(false);
  });
});
