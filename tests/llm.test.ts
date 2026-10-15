import { describe, expect, it } from "vitest";
import { LlamaServerProvider, parseWorkout } from "../src/llm/index.js";
import { swimmingTestDayExample } from "../src/llm/parser.js";
import { parsedWorkoutSchema } from "../src/llm/schema.js";
import { swimmingEffortZone } from "../src/llm/swimEffort.js";
import { recalculateWorkout, updateSwimmingThreshold } from "../src/engine/index.js";
import { completeProfile, emptyProfile } from "./fixtures/profiles.js";

// These tests replace the network/model with fixed JSON to verify the Phase 2 boundary deterministically.
const interpretedWorkout = {
  name: "Threshold Repeats",
  sport: "running",
  scheduledDate: "2026-09-27",
  steps: [
    {
      id: "intervals",
      type: "repeat",
      repetitions: 5,
      steps: [
        {
          id: "work",
          type: "work",
          duration: { kind: "distance", metres: 1000 },
          target: { kind: "threshold_speed_fraction", fraction: 1 },
        },
        { id: "recovery", type: "recovery", duration: { kind: "time", seconds: 90 } },
      ],
    },
  ],
  profileUpdates: [],
};

describe("OpenAI-compatible model provider", () => {
  it("omits the model field when llama-server should choose it", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const provider = new LlamaServerProvider({
      baseUrl: "http://model.test/v1/",
      fetch: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ok: true }) } }] }), { status: 200 });
      },
    });

    await provider.generateStructured({ messages: [], jsonSchema: { type: "object" }, maxTokens: 3072 });
    expect(requestBody).not.toHaveProperty("model");
    expect(requestBody).toHaveProperty("max_tokens", 3072);
    expect(requestBody).toHaveProperty("chat_template_kwargs", { enable_thinking: false });
  });

  it("reports token-limit JSON failures with a short response excerpt", async () => {
    const provider = new LlamaServerProvider({
      baseUrl: "http://model.test/v1",
      fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"steps": [' }, finish_reason: "length" }] }), { status: 200 }),
    });
    await expect(provider.generateStructured({ messages: [], jsonSchema: { type: "object" } }))
      .rejects.toThrow('Model reached its output token limit before completing JSON. Response ended with: {"steps": [');
  });
});

describe("natural-language interpretation boundary", () => {
  it("resolves model-generated bike Z1 recovery after an FTP update", async () => {
    const result = await parseWorkout({
      provider: { generateStructured: async () => ({
        name: "Easy ride", sport: "cycling", scheduledDate: null,
        steps: [
          { id: "work", type: "work", duration: { kind: "time", seconds: 900 }, target: { kind: "cycling_zone", zone: "endurance" } },
          { id: "recovery", type: "recovery", duration: { kind: "time", seconds: 120 }, target: { kind: "cycling_zone", zone: "recovery" } },
        ],
        profileUpdates: [{ kind: "cycling_ftp", ftpWatts: 300 }],
      }) },
      profile: emptyProfile,
      selectedSport: "cycling",
      sourcePrompt: "Ride 15 minutes in Z2, then recover for 2 minutes in Z1. My FTP is 300 W.",
      referenceDate: "2026-10-10",
      timeZone: "Australia/Sydney",
    });

    expect(result.profile.cycling.ftpWatts?.value).toBe(300);
    const endurance = result.workout.steps[0]?.target?.resolved;
    if (endurance?.kind !== "cycling_power") throw new Error("Expected resolved cycling power.");
    expect(endurance.watts).toBeCloseTo(168);
    expect(endurance.rangeWatts?.[0]).toBeCloseTo(168);
    expect(endurance.rangeWatts?.[1]).toBe(225);
    expect(result.workout.steps[1]?.target?.resolved).toMatchObject({ watts: 165, rangeWatts: [0, 165] });
    expect(result.interpretationWarnings).toEqual([]);
  });

  it.each([
    ["running", "For my run, jog 12 minutes in Z2, then do 4 x (3 minutes in Z4 + 90 seconds recovery in Z1), finishing with 8 minutes in Z2 to cool down.", "z5_aggregate"],
    ["cycling", "On the bike, warm up 12 minutes in Z2, ride 3 x (6 minutes at 105% FTP + 3 minutes recovery in Z1), and cool down for 8 minutes in Z1.", "ftp_fraction"],
    ["swimming", "At the pool, start with 200 m FS in Z2, do 4 x (50 m Drill in Z3 + 15 sec rest), and finish with 100 m Choice in Z2.", "Pull"],
  ] as const)("sends a valid %s example only on its model fallback path", async (sport, sourcePrompt, exampleMarker) => {
    const requests: string[] = [];
    await expect(parseWorkout({
      provider: { generateStructured: async (request) => {
        requests.push(request.messages[0]?.content ?? "");
        throw new Error("model intentionally unavailable");
      } },
      profile: completeProfile,
      selectedSport: sport,
      sourcePrompt,
      referenceDate: "2026-10-10",
      timeZone: "Australia/Sydney",
    })).rejects.toThrow("model intentionally unavailable");

    expect(requests).toHaveLength(2);
    const exampleJson = requests[0]?.match(/Example JSON output \(shape and nesting only; do not copy its workout values\):\n([^\n]+)/)?.[1];
    expect(exampleJson).toBeDefined();
    const example = parsedWorkoutSchema.parse(JSON.parse(exampleJson ?? ""));
    expect(example.sport).toBe(sport);
    expect(example.steps.some((step) => step.type === "repeat" && step.repetitions > 1)).toBe(true);
    expect(requests[0]).toContain(exampleMarker);
    expect(requests[0]).not.toContain("Example input (" + ({ running: "cycling", cycling: "swimming", swimming: "running" }[sport]) + ")");
    expect(requests[0]?.includes("Swim TEST/CSS example input:")).toBe(sport === "swimming");
  });

  it("supplies a valid swim test-day CSS example on the model fallback path", async () => {
    const example = parsedWorkoutSchema.parse(swimmingTestDayExample.output);
    let calls = 0;
    let systemPrompt = "";
    const result = await parseWorkout({
      provider: { generateStructured: async (request) => {
        calls += 1;
        systemPrompt = request.messages[0]?.content ?? "";
        return example;
      } },
      profile: completeProfile,
      selectedSport: "swimming",
      sourcePrompt: swimmingTestDayExample.input,
      referenceDate: "2026-10-10",
      timeZone: "Australia/Sydney",
    });

    expect(calls).toBe(1);
    const exampleJson = systemPrompt.match(/Swim TEST\/CSS example JSON \(pattern only; do not copy its workout values\):\n([^\n]+)/)?.[1];
    expect(parsedWorkoutSchema.parse(JSON.parse(exampleJson ?? ""))).toEqual(example);
    expect(systemPrompt).toContain('The plus in "CSS + 5 sec/100m" is arithmetic');
    expect(result.workout.steps.filter((step) => step.type === "repeat").map((step) => step.type === "repeat" ? step.repetitions : 0)).toEqual([2, 2]);
    expect(result.workout.steps[1]).toMatchObject({ type: "work", duration: { metres: 400 }, notes: expect.stringContaining("RECORD TIME") });
    expect(result.workout.steps[2]).toMatchObject({ type: "recovery", duration: { seconds: 300 } });
    expect(result.workout.steps[3]).toMatchObject({ type: "work", duration: { metres: 200 }, notes: expect.stringContaining("RECORD TIME") });
    expect(result.workout.steps[1]).not.toHaveProperty("target");
    expect(result.workout.steps[3]).not.toHaveProperty("target");
    expect(result.workout.steps[4]).toMatchObject({ type: "repeat", steps: [
      { type: "work", target: { prescriptionKind: "threshold_offset", offsetSecPer100m: 5 } },
      { type: "rest", duration: { seconds: 15 } },
    ] });
    expect(result.interpretationWarnings).toEqual([]);
  });

  it("sends the selected sport with the request and retries a mismatched sport", async () => {
    const messages: string[] = [];
    const schemas: string[] = [];
    let calls = 0;
    const result = await parseWorkout({
      provider: { generateStructured: async (request) => {
        calls += 1;
        messages.push(request.messages.map((message) => message.content).join("\n"));
        schemas.push(JSON.stringify(request.jsonSchema));
        return {
          name: "Ambiguous Hundreds",
          sport: calls === 1 ? "running" : "swimming",
          scheduledDate: null,
          steps: [{
            id: "hundreds",
            type: "repeat",
            repetitions: 10,
            steps: [{ id: "work", type: "work", duration: { kind: "distance", metres: 100 } }],
          }],
          profileUpdates: [],
        };
      } },
      profile: completeProfile,
      selectedSport: "swimming",
      sourcePrompt: "10 x 100 in Z2.",
      referenceDate: "2026-10-10",
      timeZone: "Australia/Sydney",
    });

    expect(calls).toBe(2);
    expect(messages[0]).toContain("Selected sport: swimming");
    expect(messages[0]).toContain("Workout request:\n10 x 100 in Z2.");
    expect(messages[1]).toContain("sport must be exactly swimming");
    expect(schemas[0]).toContain("swimming_zone");
    expect(schemas[0]).not.toContain("threshold_speed_fraction");
    expect(result.workout.sport).toBe("swimming");
  });

  it("retries once when the provider returns invalid or truncated content", async () => {
    let calls = 0;
    const result = await parseWorkout({
      provider: { generateStructured: async () => {
        calls += 1;
        if (calls === 1) throw new Error("Llama server returned invalid JSON content.");
        return interpretedWorkout;
      } },
      profile: completeProfile,
      selectedSport: "running",
      sourcePrompt: "Tomorrow 5 x 1 km at threshold with 90 sec recovery.",
      referenceDate: "2026-09-26",
      timeZone: "America/New_York",
    });

    expect(calls).toBe(2);
    expect(result.workout.sport).toBe("running");
  });

  it("compiles semantic model output and resolves targets deterministically", async () => {
    const result = await parseWorkout({
      provider: { generateStructured: async () => interpretedWorkout },
      profile: completeProfile,
      selectedSport: "running",
      sourcePrompt: "Tomorrow 5 x 1 km at threshold with 90 sec recovery.",
      referenceDate: "2026-09-26",
      timeZone: "America/New_York",
    });

    expect(result.workout.scheduledDate).toBe("2026-09-27");
    const repeat = result.workout.steps[0];
    if (repeat?.type !== "repeat") throw new Error("Expected repeat group.");
    expect(repeat.steps[0]?.target?.resolved).toMatchObject({ kind: "running_pace", paceSecPerKm: 265 });
    expect(result.warnings).toHaveLength(0);
  });

  it("reports a missing baseline without inventing a target", async () => {
    const result = await parseWorkout({
      provider: { generateStructured: async () => interpretedWorkout },
      profile: {
        ...completeProfile,
        running: { paceZoneSystem: "friel_trainingpeaks" },
      },
      selectedSport: "running",
      sourcePrompt: "5 x 1 km at threshold.",
      referenceDate: "2026-09-26",
      timeZone: "America/New_York",
    });

    expect(result.warnings[0]?.code).toBe("RUNNING_THRESHOLD_PACE_REQUIRED");
  });

  it("assigns deterministic running defaults when the model provides no pace", async () => {
    const result = await parseWorkout({
      provider: { generateStructured: async () => ({
        name: "Unpaced Running Session",
        sport: "running",
        scheduledDate: null,
        steps: [
          { id: "warmup", type: "warmup", duration: { kind: "time", seconds: 600 } },
          { id: "work", type: "work", duration: { kind: "distance", metres: 1000 } },
          { id: "cooldown", type: "cooldown", duration: { kind: "time", seconds: 600 } },
        ],
        profileUpdates: [],
      }) },
      profile: completeProfile,
      selectedSport: "running",
      sourcePrompt: "Run 1 km with warmup and cooldown.",
      referenceDate: "2026-09-26",
      timeZone: "America/New_York",
    });

    expect(result.workout.steps[0]?.target?.resolved).toMatchObject({ kind: "running_pace" });
    expect(result.workout.steps[1]?.target?.resolved).toMatchObject({ kind: "running_pace", paceSecPerKm: 265 });
    expect(result.workout.steps[2]?.target?.resolved).toMatchObject({ kind: "running_pace" });
  });

  it("normalizes numeric running-zone aliases from a lightweight local model", async () => {
    const result = await parseWorkout({
      provider: { generateStructured: async () => ({
        name: "Eight by Two Minutes",
        sport: "running",
        scheduledDate: null,
        steps: [
          { id: "warmup", type: "warmup", duration: { kind: "time", seconds: 600 }, target: { kind: "running_zone", zone: "2" } },
          {
            id: "main-set",
            type: "repeat",
            repetitions: 8,
            steps: [
              { id: "work", type: "work", duration: { kind: "time", seconds: 120 }, target: { kind: "running_zone", zone: "5" } },
              { id: "recovery", type: "recovery", duration: { kind: "time", seconds: 120 }, target: { kind: "running_zone", zone: "1" } },
            ],
          },
          { id: "cooldown", type: "cooldown", duration: { kind: "time", seconds: 300 }, target: { kind: "running_zone", zone: 2 } },
        ],
        profileUpdates: [],
      }) },
      profile: completeProfile,
      selectedSport: "running",
      sourcePrompt: "10 min Z2, 8 x (2 min Z5 + 2 min Z1), 5 min Z2.",
      referenceDate: "2026-10-10",
      timeZone: "Australia/Sydney",
    });

    expect(result.workout.steps[0]?.target).toMatchObject({ prescriptionKind: "pace_zone", zone: "z2_aerobic" });
    const mainSet = result.workout.steps[1];
    if (mainSet?.type !== "repeat") throw new Error("Expected repeat group.");
    expect(mainSet.steps[0]?.target).toMatchObject({ prescriptionKind: "pace_zone", zone: "z5_aggregate" });
    expect(mainSet.steps[1]?.target).toMatchObject({ prescriptionKind: "pace_zone", zone: "z1_recovery" });
    expect(result.workout.steps[2]?.target).toMatchObject({ prescriptionKind: "pace_zone", zone: "z2_aerobic" });
  });

  it("resolves cycling FTP and swimming CSS prescriptions", async () => {
    const cycling = await parseWorkout({
      provider: { generateStructured: async () => ({
        name: "FTP Repeats",
        sport: "cycling",
        scheduledDate: null,
        steps: [{
          id: "intervals",
          type: "repeat",
          repetitions: 3,
          steps: [{ id: "work", type: "work", duration: { kind: "time", seconds: 480 }, target: { kind: "ftp_fraction", fraction: 1.05 } }],
        }],
        profileUpdates: [],
      }) },
      profile: completeProfile,
      selectedSport: "cycling",
      sourcePrompt: "Ride 3 x 8 min at 105% FTP.",
      referenceDate: "2026-10-10",
      timeZone: "Australia/Sydney",
    });
    expect(cycling.workout.sport).toBe("cycling");
    const cyclingRepeat = cycling.workout.steps[0];
    if (cyclingRepeat?.type !== "repeat") throw new Error("Expected cycling repeat group.");
    expect(cyclingRepeat.steps[0]?.target?.resolved).toMatchObject({ kind: "cycling_power", watts: 315 });

    const swimming = await parseWorkout({
      provider: { generateStructured: async () => ({
        name: "CSS Hundreds",
        sport: "swimming",
        scheduledDate: null,
        steps: [{
          id: "hundreds",
          type: "repeat",
          repetitions: 10,
          steps: [{ id: "work", type: "work", duration: { kind: "distance", metres: 100 }, target: { kind: "swimming_threshold_offset", offsetSecPer100m: 5 }, notes: "pull with paddles" }],
        }],
        profileUpdates: [],
      }) },
      profile: completeProfile,
      selectedSport: "swimming",
      sourcePrompt: "Swim 10 x 100 pull with paddles at CSS + 5.",
      referenceDate: "2026-10-10",
      timeZone: "Australia/Sydney",
    });
    expect(swimming.workout.sport).toBe("swimming");
    const swimmingRepeat = swimming.workout.steps[0];
    if (swimmingRepeat?.type !== "repeat") throw new Error("Expected swimming repeat group.");
    expect(swimmingRepeat.steps[0]?.target?.resolved).toMatchObject({ kind: "swimming_pace", paceSecPer100m: 95 });
    expect(swimmingRepeat.steps[0]?.notes).toBe("pull with paddles");
  });

  it("retries when a model collapses plus-separated swim components into notes", async () => {
    let calls = 0;
    const result = await parseWorkout({
      provider: { generateStructured: async () => {
        calls += 1;
        return calls === 1
          ? {
            name: "Swim Set",
            sport: "swimming",
            scheduledDate: null,
            steps: [{
              id: "collapsed",
              type: "work",
              duration: { kind: "distance", metres: 100 },
              notes: "100m freestyle in Z2 + 100m pull in Z2 + 10 sec rest",
            }],
            profileUpdates: [],
          }
          : {
            name: "Swim Set",
            sport: "swimming",
            scheduledDate: null,
            steps: [
              { id: "free", type: "warmup", duration: { kind: "distance", metres: 100 }, target: { kind: "swimming_zone", zone: "2" }, notes: "FS" },
              { id: "pull", type: "warmup", duration: { kind: "distance", metres: 100 }, target: { kind: "swimming_zone", zone: "z2" }, notes: "pull" },
              { id: "rest", type: "rest", duration: { kind: "time", seconds: 10 } },
            ],
            profileUpdates: [],
          };
      } },
      profile: completeProfile,
      selectedSport: "swimming",
      sourcePrompt: "1 x (100 FS in Z2 + 100 Pull in Z2 + 10 sec rest).",
      referenceDate: "2026-10-10",
      timeZone: "Australia/Sydney",
    });

    expect(calls).toBe(2);
    expect(result.workout.steps).toHaveLength(3);
    expect(result.workout.steps.map((step) => step.notes)).toEqual(["FS", "pull", undefined]);
    expect(result.workout.steps[0]?.target).toMatchObject({ prescriptionKind: "pace_zone", zone: "z2_aerobic" });
    expect(result.workout.steps[0]?.target?.resolved).toMatchObject({ paceSecPer100m: 102.6, rangePaceSecPer100m: [102.6, 116.1] });
  });

  it("rejects flattened swim repeats and rests mislabeled as cooldowns", async () => {
    let calls = 0;
    const result = await parseWorkout({
      provider: { generateStructured: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            name: "Broken Main Set",
            sport: "swimming",
            scheduledDate: null,
            steps: [
              { id: "400", type: "work", duration: { kind: "distance", metres: 400 }, target: { kind: "swimming_zone", zone: "4" }, notes: "FS" },
              { id: "200", type: "work", duration: { kind: "distance", metres: 200 }, target: { kind: "swimming_zone", zone: "4" }, notes: "pull" },
              { id: "wrong-rest-1", type: "cooldown", duration: { kind: "time", seconds: 30 }, notes: "rest" },
              { id: "wrong-rest-2", type: "cooldown", duration: { kind: "time", seconds: 30 }, notes: "rest" },
            ],
            profileUpdates: [],
          };
        }
        return {
          name: "Main Set",
          sport: "swimming",
          scheduledDate: null,
          steps: [
            {
              id: "400-repeat",
              type: "repeat",
              repetitions: 2,
              steps: [
                { id: "400", type: "work", duration: { kind: "distance", metres: 400 }, target: { kind: "swimming_zone", zone: "4" }, notes: "FS" },
                { id: "400-rest", type: "rest", duration: { kind: "time", seconds: 30 } },
              ],
            },
            {
              id: "200-repeat",
              type: "repeat",
              repetitions: 2,
              steps: [
                { id: "200", type: "work", duration: { kind: "distance", metres: 200 }, target: { kind: "swimming_zone", zone: "4" }, notes: "pull" },
                { id: "200-rest", type: "rest", duration: { kind: "time", seconds: 30 } },
              ],
            },
          ],
          profileUpdates: [],
        };
      } },
      profile: completeProfile,
      selectedSport: "swimming",
      sourcePrompt: "Please interpret this swim workout:\nMain Set:\n2 x (400 FS in Z4 + 30 sec rest),\n2 x (200 Pull in Z4 + 30 sec rest).",
      referenceDate: "2026-10-10",
      timeZone: "Australia/Sydney",
    });

    expect(calls).toBe(2);
    expect(result.workout.steps.map((step) => step.type)).toEqual(["repeat", "repeat"]);
  });

  it("maps swimming zones to the TrainingPeaks Joe Friel convention", async () => {
    const result = await parseWorkout({
      provider: { generateStructured: async () => ({
          name: "Zone Four Swim",
          sport: "swimming",
          scheduledDate: null,
          steps: [{
            id: "work",
            type: "work",
            duration: { kind: "distance", metres: 400 },
            target: { kind: "swimming_zone", zone: "4" },
            notes: "FS",
          }],
          profileUpdates: [],
        }) },
      profile: completeProfile,
      selectedSport: "swimming",
      sourcePrompt: "400 FS in Z4.",
      referenceDate: "2026-10-10",
      timeZone: "Australia/Sydney",
    });

    expect(result.workout.steps[0]?.target).toMatchObject({
      prescriptionKind: "pace_zone",
      zoneSystem: "joe_friel_trainingpeaks",
      zone: "z4_threshold",
      resolved: { paceSecPer100m: 90.9, rangePaceSecPer100m: [90.9, 94.5] },
    });
    expect(result.workout.steps[0]?.notes).toBe("FS");
  });

  it("accepts valid model output with missing sections but flags it for review", async () => {
    let calls = 0;
    const result = await parseWorkout({
      provider: { generateStructured: async () => {
        calls += 1;
        const main = { id: "main", type: "work", duration: { kind: "distance", metres: 400 }, target: { kind: "swimming_zone", zone: "4" }, notes: "FS" } as const;
        return { name: "Incomplete Swim", sport: "swimming", scheduledDate: null, steps: [main], profileUpdates: [] };
      } },
      profile: completeProfile,
      selectedSport: "swimming",
      sourcePrompt: "Warm Up:\n1 x (100 FS in Z2 + 100 Pull in Z2 + 10 secs rest).\nMain Set:\n1 x 400 FS in Z4.\nWarm Down:\n200 Choice in Z2.",
      referenceDate: "2026-10-10",
      timeZone: "Australia/Sydney",
    });

    expect(calls).toBe(1);
    expect(result.workout.steps.map((step) => step.type)).toEqual(["work"]);
    expect(result.interpretationWarnings).toEqual(expect.arrayContaining([
      expect.stringContaining("warm-up"),
      expect.stringContaining("cool-down"),
    ]));
  });

  it("shows repeat, rest, and swim-note differences without discarding valid JSON", async () => {
    let calls = 0;
    const result = await parseWorkout({
      provider: { generateStructured: async () => {
        calls += 1;
        return {
          name: "Swim to review", sport: "swimming", scheduledDate: null,
          steps: [{ id: "repeat", type: "repeat", repetitions: 3, steps: [
            { id: "work", type: "work", duration: { kind: "distance", metres: 50 }, target: { kind: "swimming_zone", zone: "z3_tempo" }, notes: "FS" },
            { id: "rest", type: "rest", duration: { kind: "time", seconds: 20 } },
          ] }], profileUpdates: [],
        };
      } },
      profile: completeProfile,
      selectedSport: "swimming",
      sourcePrompt: "At the pool, do 4 x (50 m Drill in Z3 + 15 sec rest).",
      referenceDate: "2026-10-10",
      timeZone: "Australia/Sydney",
    });

    expect(calls).toBe(1);
    expect(result.workout.steps[0]).toMatchObject({ type: "repeat", repetitions: 3 });
    expect(result.interpretationWarnings).toEqual(expect.arrayContaining([
      expect.stringContaining("Repeat groups differ"),
      expect.stringContaining("Timed rests differ"),
      expect.stringContaining("Swim notes differ"),
    ]));
  });

  it("parses the full structured swim fixture without calling the model", async () => {
    let calls = 0;
    const result = await parseWorkout({
      provider: { generateStructured: async () => {
        calls += 1;
        throw new Error("Llama server returned invalid JSON content.");
      } },
      profile: completeProfile,
      selectedSport: "swimming",
      sourcePrompt: `Warm Up:
1 x (100 FS in Z2 + 100 Pull in Z2 + 10 secs rest),
1 x (100 FS in Z2 + 100 Pull in Z3 + 15 secs rest),
1 x (100 FS in Z2 + 100 Pull in Z4 + 15 secs rest).

Main Set:
2 x (400 FS in Z4 + 30 sec rests),
2 x (200 Pull in Z4 + 30 sec rests),
2 x (200 FS in Z4 + 30 sec rests),
2 x (100 Pull in Z4 + 30 sec rests).

Warm Down:
1 x (100 Pull in Z2 + 100 FS in Z2),
1 x (200 Choice in Z2).`,
      referenceDate: "2026-10-10",
      timeZone: "Australia/Sydney",
    });

    expect(calls).toBe(0);
    expect(result.workout.steps).toHaveLength(16);
    expect(result.workout.steps.filter((step) => step.type === "repeat").map((step) => step.type === "repeat" ? step.repetitions : 0)).toEqual([2, 2, 2, 2]);
    expect(result.workout.steps[0]).toMatchObject({ type: "warmup", notes: "FS", target: { prescriptionKind: "pace_zone", zone: "z2_aerobic" } });
    expect(result.workout.steps[2]).toMatchObject({ type: "rest", duration: { seconds: 10 } });
    expect(result.workout.steps.at(-1)).toMatchObject({ type: "cooldown", notes: "Choice" });
  });

  it("parses a sectioned swim with a multi-line repeated set and back/breast strokes deterministically", async () => {
    let calls = 0;
    const result = await parseWorkout({
      provider: { generateStructured: async () => {
        calls += 1;
        throw new Error("The model should not be called for this structured swim.");
      } },
      profile: completeProfile,
      selectedSport: "swimming",
      sourcePrompt: `Warm Up:
1 x (100 FS in Z2 + 100 FS in Z4 + 20 secs rest),
1 x (50 FS in Z2 + 150 FS in Z4 + 20 secs rest),
1 x (200 FS in Z4 + 30 secs rest).

Main Set: Repeat 3 sets of 500 as below:
1 x (100 FS in Z2 + 10 secs rest),
1 x (100 FS in Z3 + 10 secs rest),
1 x (100 FS in Z4 + 10 secs rest),
1 x (100 FS in Z5 + 10 secs rest),
1 x (100 Pull in Z2 + 10 secs rest).

Warm Down:
1 x (100 Kick in Z2 + 100 FS in Z2 + 15 secs rest),
1 x (50 Back in Z2 + 50 Breast in Z2 + 10 secs rest),
1 x (200 Choice in Z2).`,
      referenceDate: "2026-10-10",
      timeZone: "Australia/Sydney",
    });

    expect(calls).toBe(0);
    expect(result.interpretationWarnings).not.toEqual(expect.arrayContaining([expect.stringContaining("Repeat groups differ")]));
    expect(result.workout.steps).toHaveLength(16);
    expect(result.workout.steps[8]).toMatchObject({
      type: "repeat",
      repetitions: 3,
      steps: [
        { type: "work", duration: { kind: "distance", metres: 100 }, notes: "FS" },
        { type: "rest", duration: { kind: "time", seconds: 10 } },
        { type: "work", duration: { kind: "distance", metres: 100 }, notes: "FS" },
        { type: "rest", duration: { kind: "time", seconds: 10 } },
        { type: "work", duration: { kind: "distance", metres: 100 }, notes: "FS" },
        { type: "rest", duration: { kind: "time", seconds: 10 } },
        { type: "work", duration: { kind: "distance", metres: 100 }, notes: "FS" },
        { type: "rest", duration: { kind: "time", seconds: 10 } },
        { type: "work", duration: { kind: "distance", metres: 100 }, notes: "Pull" },
        { type: "rest", duration: { kind: "time", seconds: 10 } },
      ],
    });
    expect(result.workout.steps[12]).toMatchObject({ type: "cooldown", duration: { metres: 50 }, notes: "Back" });
    expect(result.workout.steps[13]).toMatchObject({ type: "cooldown", duration: { metres: 50 }, notes: "Breast" });
  });

  it("preserves the sectioned swim test day, resolves effort zones, and leaves time trials open without a model call", async () => {
    let calls = 0;
    const result = await parseWorkout({
      provider: { generateStructured: async () => {
        calls += 1;
        throw new Error("The model should not be called for this swim test day.");
      } },
      profile: completeProfile,
      selectedSport: "swimming",
      sourcePrompt: `Warm up:
6 x (50 Steady, 20s rests),
4 x (25 FS Hard + 25 FS Steady, 20s rests).

-----------
TEST:
1 x 400 FS maximal effort time trial, RECORD TIME,
5 mins Easy for active recovery,
1 x 200 FS maximal effort time trial, RECORD TIME,
1 min rest
-----------

Main Set:
1 x 100 FS Easy, 15s rest,
1 x 100 FS Steady, 15s rest,
1 x 100 FS Moderately Hard, 15s rest,
1 x 100 FS Hard, 60s rest,
4 x 50 FS Build Easy to Hard
60 secs rest.

Warm Down:
200 Choice, Steady`,
      referenceDate: "2026-10-10",
      timeZone: "Australia/Sydney",
    });

    expect(calls).toBe(0);
    expect(result.workout.name).toBe("Swim test workout");
    expect(result.workout.steps.filter((step) => step.type === "repeat").map((step) => step.type === "repeat" ? step.repetitions : 0)).toEqual([6, 4, 4]);
    expect(result.workout.steps[0]).toMatchObject({ type: "repeat", steps: [
      { type: "warmup", duration: { metres: 50 }, notes: "Steady" },
      { type: "rest", duration: { seconds: 20 } },
    ] });
    expect(result.workout.steps[1]).toMatchObject({ type: "repeat", steps: [
      { type: "warmup", duration: { metres: 25 }, notes: "FS Hard" },
      { type: "warmup", duration: { metres: 25 }, notes: "FS Steady" },
      { type: "rest", duration: { seconds: 20 } },
    ] });
    expect(result.workout.steps.slice(2, 6)).toMatchObject([
      { type: "work", duration: { metres: 400 }, notes: "FS maximal effort time trial RECORD TIME" },
      { type: "recovery", duration: { seconds: 300 }, notes: "Easy active recovery" },
      { type: "work", duration: { metres: 200 }, notes: "FS maximal effort time trial RECORD TIME" },
      { type: "rest", duration: { seconds: 60 } },
    ]);
    expect(result.workout.steps.at(-1)).toMatchObject({ type: "cooldown", duration: { metres: 200 }, notes: "Choice Steady" });
    expect(result.workout.steps[14]).toMatchObject({ type: "repeat", repetitions: 4, steps: [
      { type: "work", duration: { metres: 50 }, notes: "FS Build Easy to Hard" },
    ] });
    expect(result.workout.steps[15]).toMatchObject({ type: "rest", duration: { seconds: 60 } });
    const firstWarmup = result.workout.steps[0];
    const secondWarmup = result.workout.steps[1];
    if (firstWarmup?.type !== "repeat" || secondWarmup?.type !== "repeat") throw new Error("Expected warm-up repeats.");
    expect(firstWarmup.steps[0]?.target).toMatchObject({ zone: "z2_aerobic", resolved: { kind: "swimming_pace" } });
    expect(secondWarmup.steps[0]?.target).toMatchObject({ zone: "z5a_super_threshold" });
    expect(secondWarmup.steps[1]?.target).toMatchObject({ zone: "z2_aerobic" });
    expect(result.workout.steps[3]?.target).toMatchObject({ zone: "z1_recovery" });
    expect(result.workout.steps[6]?.target).toMatchObject({ zone: "z1_recovery" });
    expect(result.workout.steps[8]?.target).toMatchObject({ zone: "z2_aerobic" });
    expect(result.workout.steps[10]?.target).toMatchObject({ zone: "z3_tempo" });
    expect(result.workout.steps[12]?.target).toMatchObject({ zone: "z5a_super_threshold" });
    expect(result.workout.steps.at(-1)?.target).toMatchObject({ zone: "z2_aerobic" });
    const build = result.workout.steps[14];
    if (build?.type !== "repeat") throw new Error("Expected build repeat.");
    expect(build.steps[0]).not.toHaveProperty("target");
    const afterCssChange = recalculateWorkout(result.workout, updateSwimmingThreshold(result.profile, 100));
    const changedWarmup = afterCssChange.steps[0];
    if (changedWarmup?.type !== "repeat") throw new Error("Expected warm-up repeat.");
    expect(changedWarmup.steps[0]?.target?.resolved).toMatchObject({ paceSecPer100m: 114 });
    const totalMetres = (steps: typeof result.workout.steps): number => steps.reduce((sum, step) => {
      if (step.type === "repeat") return sum + step.repetitions * totalMetres(step.steps);
      return sum + (step.duration.kind === "distance" ? step.duration.metres : 0);
    }, 0);
    expect(totalMetres(result.workout.steps)).toBe(1900);
    expect(result.workout.steps[2]).not.toHaveProperty("target");
    expect(result.workout.steps[4]).not.toHaveProperty("target");
    expect(result.interpretationWarnings).toEqual([]);
  });

  it.each([
    ["Very Easy", 100, "z1_recovery"],
    ["Easy", 100, "z1_recovery"],
    ["Steady", 100, "z2_aerobic"],
    ["Moderate", 100, undefined],
    ["Moderately Hard", 100, "z3_tempo"],
    ["Hard", 100, "z5a_super_threshold"],
    ["Hard", 200, "z4_threshold"],
    ["Very Hard", 50, "z5b_anaerobic_endurance"],
    ["Very Hard", 200, "z5a_super_threshold"],
    ["Sprint", 50, "z5c_power"],
    ["All-out", 100, undefined],
    ["Build Easy to Hard", 50, undefined],
    ["max effort", 50, undefined],
    ["maximal effort time trial RECORD TIME", 400, undefined],
  ] as const)("maps swim wording %s over %i m to %s", (wording, metres, zone) => {
    expect(swimmingEffortZone(`FS ${wording}`, { kind: "distance", metres })).toBe(zone);
  });

  it("uses the same swim wording rules for model fallback without overriding an explicit zone or pacing a maximal test", async () => {
    let calls = 0;
    const result = await parseWorkout({
      provider: { generateStructured: async () => {
        calls += 1;
        return {
          name: "Mixed swim", sport: "swimming", scheduledDate: null,
          steps: [
            { id: "steady", type: "work", duration: { kind: "distance", metres: 100 }, notes: "FS Steady" },
            { id: "explicit-zone", type: "work", duration: { kind: "distance", metres: 50 }, notes: "FS Hard", target: { kind: "swimming_zone", zone: "z2_aerobic" } },
            { id: "test", type: "work", duration: { kind: "distance", metres: 400 }, notes: "FS maximal effort time trial RECORD TIME", target: { kind: "swimming_zone", zone: "z5c_power" } },
          ], profileUpdates: [],
        };
      } },
      profile: completeProfile,
      selectedSport: "swimming",
      sourcePrompt: "At the pool swim 100 FS Steady, 50 FS Hard in Z2, then a 400 FS maximal effort time trial, RECORD TIME.",
      referenceDate: "2026-10-10",
      timeZone: "Australia/Sydney",
    });
    expect(calls).toBe(1);
    expect(result.workout.steps[0]?.target).toMatchObject({ zone: "z2_aerobic", source: "profile_derived" });
    expect(result.workout.steps[1]?.target).toMatchObject({ zone: "z2_aerobic" });
    expect(result.workout.steps[2]).not.toHaveProperty("target");
  });

  it("keeps the deterministic route when a swim group wraps before rest", async () => {
    let calls = 0;
    const result = await parseWorkout({
      provider: { generateStructured: async () => {
        calls += 1;
        throw new Error("The model should not be called for the wrapped fixture.");
      } },
      profile: completeProfile,
      selectedSport: "swimming",
      sourcePrompt: `Warm Up:
1 x (100 FS in Z2 + 100 Pull in Z2 + 10 secs
rest),
1 x (100 FS in Z2 + 100 Pull in Z3 + 15 secs rest),
1 x (100 FS in Z2 + 100 Pull in Z4 + 15 secs rest).

Main Set:
2 x (400 FS in Z4 + 30 sec rests),
2 x (200 Pull in Z4 + 30 sec rests),
2 x (200 FS in Z4 + 30 sec rests),
2 x (100 Pull in Z4 + 30 sec rests).

Warm Down:
1 x (100 Pull in Z2 + 100 FS in Z2),
1 x (200 Choice in Z2).`,
      referenceDate: "2026-10-10",
      timeZone: "Australia/Sydney",
    });

    expect(calls).toBe(0);
    expect(result.workout.steps).toHaveLength(16);
    expect(result.workout.steps.filter((step) => step.type === "repeat").map((step) => step.type === "repeat" ? step.repetitions : 0)).toEqual([2, 2, 2, 2]);
    expect(result.workout.steps[2]).toMatchObject({ type: "rest", duration: { seconds: 10 } });
  });

  it("parses sectioned Run repeats without calling the model", async () => {
    let calls = 0;
    const result = await parseWorkout({
      provider: { generateStructured: async () => { calls += 1; throw new Error("Model should not be called."); } },
      profile: completeProfile,
      selectedSport: "running",
      sourcePrompt: `Warm Up:
10 mins in Z2.

Main Set:
8 x (2 mins in Z5 + 2 min recoveries In Z1).

Warm Down:
5 mins in Z2.`,
      referenceDate: "2026-10-10",
      timeZone: "Australia/Sydney",
    });

    expect(calls).toBe(0);
    expect(result.workout.steps).toHaveLength(3);
    expect(result.workout.steps[0]).toMatchObject({ type: "warmup", duration: { seconds: 600 }, target: { zone: "z2_aerobic" } });
    expect(result.workout.steps[1]).toMatchObject({ type: "repeat", repetitions: 8, steps: [
      { type: "work", duration: { seconds: 120 }, target: { zone: "z5_aggregate" } },
      { type: "recovery", duration: { seconds: 120 }, target: { zone: "z1_recovery" } },
    ] });
    expect(result.workout.steps[2]).toMatchObject({ type: "cooldown", duration: { seconds: 300 }, target: { zone: "z2_aerobic" } });
  });

  it("parses sectioned Ride intervals and retains unquantified zone wording without the model", async () => {
    let calls = 0;
    const result = await parseWorkout({
      provider: { generateStructured: async () => { calls += 1; throw new Error("Model should not be called."); } },
      profile: completeProfile,
      selectedSport: "cycling",
      sourcePrompt: `Warm Up:
5 mins in low Z2.

Main Set:
20 in upper Z2 + 2 min recoveries in Z1-2,
15 in upper Z2 + 2 min recoveries in Z1-2,
10 in upper Z2.

Warm Down:
5 mins in low Z2.`,
      referenceDate: "2026-10-10",
      timeZone: "Australia/Sydney",
    });

    expect(calls).toBe(0);
    expect(result.workout.steps.map((step) => step.type)).toEqual(["warmup", "work", "recovery", "work", "recovery", "work", "cooldown"]);
    expect(result.workout.steps.map((step) => step.type === "repeat" ? 0 : step.duration.kind === "time" ? step.duration.seconds : 0))
      .toEqual([300, 1200, 120, 900, 120, 600, 300]);
    expect(result.workout.steps[0]).toMatchObject({ notes: "low Z2", target: { prescriptionKind: "power_zone", zone: "endurance" } });
    expect(result.workout.steps[1]).toMatchObject({ notes: "upper Z2", target: { prescriptionKind: "power_zone", zone: "endurance" } });
    expect(result.workout.steps[2]).toMatchObject({ notes: "Z1-2" });
    expect(result.workout.steps[2]?.target).toBeUndefined();
  });

  it("keeps ambiguous bare Ride durations on the model path", async () => {
    let calls = 0;
    const result = await parseWorkout({
      provider: { generateStructured: async () => {
        calls += 1;
        return { name: "Ambiguous ride", sport: "cycling", scheduledDate: null, steps: [
          { id: "work", type: "work", duration: { kind: "time", seconds: 1200 }, target: { kind: "cycling_zone", zone: "endurance" } },
        ], profileUpdates: [] };
      } },
      profile: completeProfile,
      selectedSport: "cycling",
      sourcePrompt: "Main Set:\n20 in upper Z2.",
      referenceDate: "2026-10-10",
      timeZone: "Australia/Sydney",
    });

    expect(calls).toBe(1);
    expect(result.workout.steps[0]).toMatchObject({ type: "work", duration: { seconds: 1200 } });
  });

  it("keeps explicit distance units in sectioned Run blocks", async () => {
    let calls = 0;
    const result = await parseWorkout({
      provider: { generateStructured: async () => { calls += 1; throw new Error("Model should not be called."); } },
      profile: completeProfile,
      selectedSport: "running",
      sourcePrompt: "Warm Up:\n1 km in Z2.\nMain Set:\n3 x (800 m in Z4 + 200 m recovery in Z1).\nWarm Down:\n1 km in Z2.",
      referenceDate: "2026-10-10",
      timeZone: "Australia/Sydney",
    });

    expect(calls).toBe(0);
    expect(result.workout.steps[0]).toMatchObject({ type: "warmup", duration: { kind: "distance", metres: 1000 } });
    expect(result.workout.steps[1]).toMatchObject({ type: "repeat", repetitions: 3, steps: [
      { type: "work", duration: { kind: "distance", metres: 800 } },
      { type: "recovery", duration: { kind: "distance", metres: 200 } },
    ] });
  });
});
