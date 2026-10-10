import { Decoder, Stream } from "@garmin/fitsdk";
import { describe, expect, it, vi } from "vitest";
import { parseWorkout } from "../src/llm/index.js";
import { parseStructuredEndurance } from "../src/llm/structuredEndurance.js";
import { parseClockRunningStep } from "../src/llm/clockRunning.js";
import { parseRunningPaceText, recalculateWorkout } from "../src/engine/index.js";
import { exportFitWorkout } from "../src/fit/export.js";
import { exportGarminConnectJson } from "../src/garminConnectJson/export.js";
import { runningTargetSchema } from "../src/domain/index.js";
import { emptyProfile, completeProfile } from "./fixtures/profiles.js";

const sourcePrompt = "1:45:00 @ 06:00-06:40 min/km\nZone 1-Zone 2";
async function interpret(prompt = sourcePrompt) {
  const generateStructured = vi.fn(async () => { throw new Error("Model must not be called"); });
  const result = await parseWorkout({ sourcePrompt: prompt, selectedSport: "running", profile: emptyProfile,
    provider: { generateStructured }, referenceDate: "2026-10-10", timeZone: "Australia/Sydney" });
  expect(generateStructured).not.toHaveBeenCalled();
  return result;
}

describe("clock durations and explicit running pace ranges", () => {
  it("routes the exact multiline request without inference or a profile baseline", async () => {
    const { workout } = await interpret();
    expect(workout.steps).toHaveLength(1);
    expect(workout.steps[0]).toMatchObject({ type: "work", duration: { kind: "time", seconds: 6300 }, notes: "Zone 1-Zone 2",
      target: { source: "explicit", prescriptionKind: "explicit_pace", paceSecPerKm: 360, rangePaceSecPerKm: [360, 400],
        resolved: { kind: "running_pace", rangePaceSecPerKm: [360, 400] } } });
    const recalculated = recalculateWorkout(workout, completeProfile);
    expect(recalculated.steps[0]?.target).toEqual(workout.steps[0]?.target);
  });

  it.each([ ["1:45:00", 6300], ["45:00", 2700], ["0:30", 30], ["00:01:30", 90] ])("parses %s clocks", (clock, seconds) => {
    expect(parseClockRunningStep(`${clock} @ 06:00/km`)?.duration).toEqual({ kind: "time", seconds });
  });

  it.each(["-", "–", "—"])("supports %s pace and annotation separators", async (dash) => {
    const { workout } = await interpret(` 1:45:00 @ 06:00 ${dash} 06:40 min/km\r\n Zone 1${dash}Zone 2 `);
    expect(workout.steps[0]?.target?.resolved).toMatchObject({ rangePaceSecPerKm: [360, 400] });
  });

  it("keeps warm-up, repeats and cooldown structure", async () => {
    const { workout } = await interpret("Warm Up:\n10:00 @ 06:00/km\nMain Set:\n2 x (2:00 @ 04:00-04:15 min/km + 1:00 @ 06:00/km)\nWarm Down:\n5:00 @ 06:00/km");
    expect(workout.steps.map((step) => step.type)).toEqual(["warmup", "repeat", "cooldown"]);
    expect(workout.steps[1]).toMatchObject({ repetitions: 2, steps: [ { duration: { seconds: 120 } }, { duration: { seconds: 60 } } ] });
  });

  it.each(["0:00 @ 06:00/km", "1:60:00 @ 06:00/km", "10:70 @ 06:00/km", "1:45:00 @ 06:40-06:00 min/km", "1:45:00 @ 00:00/km", "1:45:00 @ 06:00-06:70 min/km", "1:45:00 @ 06:00", "1:45:00 @ 06:00/km\nZone 9", "1:45:00 @ 06:00/km\nZone 2-Zone 1", "1:45:00 @ 06:00/km\nAlso add strides"])("does not silently accept unsupported input: %s", (prompt) => {
    expect(parseStructuredEndurance(prompt, "running")).toBeUndefined();
  });

  it("does not treat a running pace as a cycling prescription", () => {
    expect(parseStructuredEndurance(sourcePrompt, "cycling")).toBeUndefined();
  });

  it("accepts pace ranges for the target editor and rejects reversed ones", () => {
    expect(parseRunningPaceText("6:00–6:40")).toEqual({ paceSecPerKm: 360, rangePaceSecPerKm: [360, 400] });
    expect(parseRunningPaceText("6:40-6:00")).toBeUndefined();
  });

  it("validates and persists the explicit range", async () => {
    const { workout } = await interpret();
    const target = runningTargetSchema.parse(JSON.parse(JSON.stringify(workout.steps[0]?.target)));
    expect(target).toMatchObject({ rangePaceSecPerKm: [360, 400] });
    expect(runningTargetSchema.safeParse({ ...target, rangePaceSecPerKm: [400, 360] }).success).toBe(false);
  });

  it("keeps both boundaries in Garmin Connect JSON", async () => {
    const { workout } = await interpret();
    const exported = exportGarminConnectJson(workout).workout;
    expect(exported).toMatchObject({ workoutSegments: [{ workoutSteps: [{ endConditionValue: 6300, targetValueOne: 1000 / 360, targetValueTwo: 1000 / 400 }] }] });
  });

  it("also accepts an explicit range from model fallback", async () => {
    const generateStructured = vi.fn(async () => ({ name: "Easy run", sport: "running", scheduledDate: null, profileUpdates: [],
      steps: [{ id: "easy", type: "work", duration: { kind: "time", seconds: 6300 }, target: { kind: "explicit_running_pace", paceSecPerKm: 360, rangePaceSecPerKm: [360, 400] } }] }));
    const result = await parseWorkout({ sourcePrompt: "Jog for one hour and forty-five minutes between six and six-forty per km.", selectedSport: "running", profile: emptyProfile,
      provider: { generateStructured }, referenceDate: "2026-10-10", timeZone: "Australia/Sydney" });
    expect(generateStructured).toHaveBeenCalledTimes(1);
    expect(result.workout.steps[0]?.target).toMatchObject({ rangePaceSecPerKm: [360, 400], resolved: { rangePaceSecPerKm: [360, 400] } });
  });

  it("round-trips duration and both speed boundaries through FIT", async () => {
    const { workout } = await interpret();
    const decoder = new Decoder(Stream.fromByteArray(exportFitWorkout(workout).bytes));
    expect(decoder.checkIntegrity()).toBe(true);
    const decoded = decoder.read();
    expect(decoded.errors).toEqual([]);
    expect(decoded.messages.workoutStepMesgs?.[0]).toMatchObject({ durationTime: 6300, targetType: "speed", customTargetSpeedLow: 2.5, customTargetSpeedHigh: 2.778 });
  });
});
