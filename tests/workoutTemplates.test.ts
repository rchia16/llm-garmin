import { describe, expect, it, vi } from "vitest";
import { parseWorkout } from "../src/llm/parser.js";
import { parseNamedWorkout, templateInstructions } from "../src/llm/workoutTemplates.js";
import type { WorkoutStep } from "../src/domain/index.js";
import type { StructuredGenerationRequest } from "../src/llm/provider.js";
import { emptyProfile } from "./fixtures/profiles.js";

const referenceDate = "2026-10-10";
const options = { profile: emptyProfile, selectedSport: "running" as const, referenceDate, timeZone: "Australia/Sydney" };

function totalSeconds(steps: WorkoutStep[]): number {
  return steps.reduce((total, step) => total + (step.type === "repeat"
    ? step.repetitions * totalSeconds(step.steps)
    : step.duration.kind === "time" ? step.duration.seconds : 0), 0);
}

describe("shared workout templates", () => {
  it.each(["Mona Fartlek", "Moneghetti Fartlek", "Steve Moneghetti's Fartlek"])("expands %s without a model call and retains relative effort targets", async (sourcePrompt) => {
    const generateStructured = vi.fn(async () => { throw new Error("Model must not be called"); });
    const result = await parseWorkout({ ...options, sourcePrompt, provider: { generateStructured } });
    expect(generateStructured).not.toHaveBeenCalled();
    expect(result.workout.name).toBe("Mona Fartlek");
    expect(result.workout.steps.map((step) => step.type === "repeat" ? step.repetitions : 0)).toEqual([2, 4, 4, 4]);
    expect(totalSeconds(result.workout.steps)).toBe(1200);
    for (const group of result.workout.steps) {
      if (group.type !== "repeat") throw new Error("Expected a repeat group");
      expect(group.steps.map((step) => step.type)).toEqual(["work", "recovery"]);
      expect(group.steps[0]?.duration).toEqual(group.steps[1]?.duration);
      const effort = group.steps[0];
      if (effort?.type === "repeat" || effort?.duration.kind !== "time") throw new Error("Expected timed effort");
      expect(effort.target).toMatchObject({ source: "profile_derived", zone: effort.duration.seconds === 15 ? "z5c_anaerobic_capacity" : effort.duration.seconds === 30 ? "z5b_aerobic_capacity" : "z5a_super_threshold" });
      expect(group.steps[1]?.target).toMatchObject({ source: "profile_derived", zone: "z2_aerobic" });
      expect(group.steps.every((step) => step.target?.resolved === undefined)).toBe(true);
    }
    expect(result.interpretationWarnings).toEqual([]);
    expect(result.profile).toEqual(emptyProfile);
  });

  it("preserves warm-up, cool-down, explicit zone and injected date without inference", async () => {
    const generateStructured = vi.fn(async () => { throw new Error("Model must not be called"); });
    const result = await parseWorkout({ ...options, provider: { generateStructured },
      sourcePrompt: "Tomorrow run Mona Fartlek with a 15-minute warm-up in Z2 and 10-minute cooldown." });
    expect(generateStructured).not.toHaveBeenCalled();
    expect(result.workout.scheduledDate).toBe("2026-10-11");
    expect(result.workout.steps[0]).toMatchObject({ type: "warmup", duration: { kind: "time", seconds: 900 }, target: { zone: "z2_aerobic" } });
    expect(result.workout.steps.at(-1)).toMatchObject({ type: "cooldown", duration: { kind: "time", seconds: 600 } });
    expect(totalSeconds(result.workout.steps)).toBe(2700);
    expect(result.interpretationWarnings).toEqual([]);
  });

  it("supports duration-after-label and distance additions", () => {
    const workout = parseNamedWorkout("Mona Fartlek, warm up for 2 km then cool down 90 seconds", "running", referenceDate);
    expect(workout?.steps[0]).toMatchObject({ type: "warmup", duration: { kind: "distance", metres: 2000 } });
    expect(workout?.steps.at(-1)).toMatchObject({ type: "cooldown", duration: { kind: "time", seconds: 90 } });
  });

  it.each([
    "A gentler Mona Fartlek for returning to running",
    "Mona Fartlek with 30-second floats",
    "Mona Fartlek with a 0-minute warm-up",
    "Mona Fartlek without the last group",
    "Mona Fartlek. My threshold is 4:20/km",
    "Mona Fartlek with 5-minute warm-up and 10-minute warm-up",
    "Mona Fartlek next Tuesday",
  ])("does not discard unrecognised instructions: %s", (sourcePrompt) => {
    expect(parseNamedWorkout(sourcePrompt, "running", referenceDate)).toBeUndefined();
  });

  it("uses the same recipe and effort mapping in fallback", async () => {
    const modelOutput = parseNamedWorkout("Mona Fartlek", "running", referenceDate);
    if (modelOutput === undefined) throw new Error("Missing template");
    modelOutput.steps.pop();
    const generateStructured = vi.fn(async (_request: StructuredGenerationRequest) => modelOutput);
    const result = await parseWorkout({ ...options, sourcePrompt: "Mona Fartlek without the last group", provider: { generateStructured } });
    expect(generateStructured).toHaveBeenCalledTimes(1);
    const instructions = generateStructured.mock.calls[0]?.[0].messages[0]?.content ?? "";
    expect(instructions).toContain('"repetitions":2,"effortSeconds":90,"floatSeconds":90');
    expect(instructions).toContain("Float is active running recovery, never passive rest");
    expect(result.workout.steps).toHaveLength(3);
    expect(result.interpretationWarnings).toEqual(["Repeat groups differ: classic template 2, 4, 4, 4; received 2, 4, 4."]);
    expect(result.workout.steps.every((step) => step.type === "repeat" && step.steps.every((child) => child.target?.source === "profile_derived"))).toBe(true);
  });

  it("retains the named recipe on the controlled fallback retry", async () => {
    const requests: StructuredGenerationRequest[] = [];
    const result = await parseWorkout({ ...options, sourcePrompt: "Mona Fartlek next Tuesday", provider: {
      generateStructured: async (request) => {
        requests.push(request);
        return requests.length === 1 ? {} : parseNamedWorkout("Mona Fartlek", "running", referenceDate);
      },
    } });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages[0]?.content).toContain("Expected repeat counts: [2, 4, 4, 4]");
    expect(result.interpretationWarnings).toEqual([]);
  });

  it("supplies relevant generic swim guidance through the actual model boundary", async () => {
    let systemPrompt = "";
    const result = await parseWorkout({ ...options, selectedSport: "swimming", sourcePrompt: "Give me a drill set", provider: {
      generateStructured: async (request) => {
        systemPrompt = request.messages[0]?.content ?? "";
        return { name: "Drill set needs details", sport: "swimming", scheduledDate: null, profileUpdates: [], steps: [
          { id: "drill", type: "work", duration: { kind: "open" }, notes: "Drill unspecified; supply distance and repetitions" },
          { id: "rest", type: "rest", duration: { kind: "open" }, notes: "Rest duration unspecified" },
        ] };
      },
    } });
    expect(systemPrompt).toContain("Drill set v1");
    expect(systemPrompt).toContain("never invent a drill");
    expect(systemPrompt).toContain("If a required parameter is missing, do not invent it");
    expect(systemPrompt).not.toContain("Mona Fartlek");
    expect(result.workout.steps[0]?.duration).toEqual({ kind: "open" });
  });

  it("does not expand generic categories or a template for a different sport", () => {
    expect(parseNamedWorkout("Cruise intervals", "running", referenceDate)).toBeUndefined();
    expect(parseNamedWorkout("CSS repeats", "swimming", referenceDate)).toBeUndefined();
    expect(parseNamedWorkout("Mona Fartlek", "swimming", referenceDate)).toBeUndefined();
    expect(templateInstructions("Mona Fartlek", "cycling")).toBe("");
  });
});
