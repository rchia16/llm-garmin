import { describe, expect, it, vi } from "vitest";
import { parseWorkout } from "../src/llm/parser.js";
import { runningEffortZone } from "../src/llm/runningEffort.js";
import { recalculateWorkout, updateRunningThreshold } from "../src/engine/index.js";
import { completeProfile, emptyProfile } from "./fixtures/profiles.js";

const options = { selectedSport: "running" as const, profile: completeProfile, referenceDate: "2026-10-10", timeZone: "Australia/Sydney" };

describe("running effort defaults", () => {
  it.each([
    ["Very Easy", "z1_recovery"], ["Easy", "z1_recovery"], ["active recovery", "z1_recovery"], ["float recovery", "z2_aerobic"],
    ["Steady", "z2_aerobic"], ["Moderately Hard", "z3_tempo"], ["Hard", "z4_threshold"], ["Very Hard", "z5a_super_threshold"],
    ["Moderate", undefined], ["Build Easy to Hard", undefined], ["progressive", undefined], ["Sprint", undefined],
    ["All-out", undefined], ["max effort", undefined], ["maximal effort time trial RECORD TIME", undefined],
  ])("maps %s without converting uncertain effort into a guessed pace", (wording, expectedZone) => {
    expect(runningEffortZone(wording)).toBe(expectedZone);
  });

  it("parses sectioned effort words with no inference and recalculates nested relative paces", async () => {
    const generateStructured = vi.fn(async () => { throw new Error("Model must not be called"); });
    const result = await parseWorkout({ ...options, provider: { generateStructured }, sourcePrompt: `Warm Up:
10 mins Easy.
Main Set:
3 x (2 mins Hard + 1 min recoveries Easy).
Warm Down:
5 mins Steady.` });
    expect(generateStructured).not.toHaveBeenCalled();
    expect(result.workout.steps[0]).toMatchObject({ type: "warmup", target: { zone: "z1_recovery", resolved: { paceSecPerKm: 341.85, paceBoundary: "slower_than" } } });
    const repeat = result.workout.steps[1];
    if (repeat?.type !== "repeat") throw new Error("Expected repeat");
    expect(repeat.repetitions).toBe(3);
    expect(repeat.steps[0]).toMatchObject({ type: "work", notes: "Hard", target: { zone: "z5a_super_threshold", resolved: { paceSecPerKm: 257.05 } } });
    expect(repeat.steps[1]).toMatchObject({ type: "recovery", target: { zone: "z1_recovery" } });
    expect(result.workout.steps[2]).toMatchObject({ type: "cooldown", target: { zone: "z2_aerobic" } });
    const updated = recalculateWorkout(result.workout, updateRunningThreshold(result.profile, 300));
    const updatedRepeat = updated.steps[1];
    if (updatedRepeat?.type !== "repeat") throw new Error("Expected updated repeat");
    expect(updatedRepeat.steps[0]?.target?.resolved).toMatchObject({ paceSecPerKm: 291 });
    expect(result.interpretationWarnings).toEqual([]);
  });

  it("retains distance blocks, explicit zones, and open effort in the deterministic path", async () => {
    const generateStructured = vi.fn(async () => { throw new Error("Model must not be called"); });
    const result = await parseWorkout({ ...options, provider: { generateStructured }, sourcePrompt: `Main Set:
1 km Hard in Z2,
100 m Sprint,
400 m maximal effort time trial,
1 min Build Easy to Hard.` });
    expect(generateStructured).not.toHaveBeenCalled();
    expect(result.workout.steps[0]).toMatchObject({ duration: { kind: "distance", metres: 1000 }, notes: "Hard", target: { zone: "z2_aerobic" } });
    expect(result.workout.steps[1]?.target).toMatchObject({ zone: "z5c_anaerobic_capacity", resolved: { paceBoundary: "faster_than" } });
    expect(result.workout.steps.slice(2).every((step) => step.target === undefined)).toBe(true);
  });

  it("uses the same mappings in model fallback and preserves explicit pace during recalculation", async () => {
    let prompt = "";
    const result = await parseWorkout({ ...options, sourcePrompt: "Run easy, hard, and a short all-out effort; use 4:00/km for the steady segment", provider: {
      generateStructured: async (request) => {
        prompt = request.messages[0]?.content ?? "";
        return { name: "Effort run", sport: "running", scheduledDate: null, profileUpdates: [], steps: [
          { id: "easy", type: "work", duration: { kind: "time", seconds: 600 }, notes: "Easy" },
          { id: "hard", type: "work", duration: { kind: "time", seconds: 120 }, notes: "Hard" },
          { id: "sprint", type: "work", duration: { kind: "time", seconds: 15 }, notes: "All-out" },
          { id: "explicit", type: "work", duration: { kind: "time", seconds: 60 }, notes: "Steady", target: { kind: "explicit_running_pace", paceSecPerKm: 240 } },
          { id: "rest", type: "rest", duration: { kind: "time", seconds: 30 } },
        ] };
      },
    } });
    expect(prompt).toContain("Preserve qualitative running effort words in step notes");
    expect(result.workout.steps[0]?.target).toMatchObject({ zone: "z1_recovery" });
    expect(result.workout.steps[1]?.target).toMatchObject({ zone: "z5a_super_threshold" });
    expect(result.workout.steps[2]?.target).toMatchObject({ zone: "z5c_anaerobic_capacity" });
    expect(result.workout.steps[4]?.target).toBeUndefined();
    const updated = recalculateWorkout(result.workout, updateRunningThreshold(result.profile, 300));
    expect(updated.steps[3]?.target?.resolved).toMatchObject({ paceSecPerKm: 240 });
    expect(updated.steps[1]?.target?.resolved).toMatchObject({ paceSecPerKm: 291 });
  });

  it("requires a running baseline rather than using swimming CSS", async () => {
    const result = await parseWorkout({ ...options, profile: { ...emptyProfile, swimming: completeProfile.swimming },
      sourcePrompt: "Main Set:\n1 min Easy.", provider: { generateStructured: async () => { throw new Error("No model call"); } } });
    expect(result.workout.steps[0]?.target?.resolved).toBeUndefined();
    expect(result.warnings).toMatchObject([{ code: "RUNNING_THRESHOLD_PACE_REQUIRED" }]);
  });
});
