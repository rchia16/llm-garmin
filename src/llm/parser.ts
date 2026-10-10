import { dateSchema, type AthleteProfile, type Duration, type Sport, type Target, type Workout, type WorkoutStep } from "../domain/index.js";
import {
  explicitCyclingWatts,
  explicitRunningPace,
  explicitRunningPaceRange,
  explicitSwimmingPace,
  defaultRunningTarget,
  ftpTarget,
  runningZoneTarget,
  swimmingZoneTarget,
  swimmingThresholdOffset,
  thresholdRunningTarget,
  type UpdateMetadata,
  updateCyclingFTP,
  updateRunningThreshold,
  updateSwimmingThreshold,
} from "../engine/index.js";
import { resolveWorkoutTargets } from "../engine/resolve.js";
import type { ModelProvider } from "./provider.js";
import { parsedWorkoutJsonSchemaForSport, parsedWorkoutSchema, type ParsedDuration, type ParsedStep, type ParsedTarget, type ParsedWorkout } from "./schema.js";
import { parseStructuredEndurance } from "./structuredEndurance.js";
import { parseStructuredSwim } from "./structuredSwim.js";
import { isOpenSwimEffort, swimmingEffortZone } from "./swimEffort.js";
import { namedTemplateRepeatCounts, parseNamedWorkout, templateInstructions } from "./workoutTemplates.js";
import { isOpenRunningEffort, runningEffortZone } from "./runningEffort.js";

export type ParseWorkoutOptions = {
  provider: ModelProvider;
  profile: AthleteProfile;
  selectedSport: Sport;
  sourcePrompt: string;
  referenceDate: string;
  timeZone: string;
  signal?: AbortSignal;
};

export type ParseWorkoutResult = {
  workout: Workout;
  profile: AthleteProfile;
  warnings: Workout["resolutionWarnings"];
  interpretationWarnings: string[];
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function durationFromParsed(duration: ParsedDuration): Duration {
  return duration;
}

function targetFromParsed(target: ParsedTarget): Target {
  switch (target.kind) {
    case "explicit_running_pace": return target.rangePaceSecPerKm === undefined ? explicitRunningPace(target.paceSecPerKm) : explicitRunningPaceRange(...target.rangePaceSecPerKm);
    case "threshold_speed_fraction": return thresholdRunningTarget(target.fraction);
    case "running_zone": return runningZoneTarget(target.zone);
    case "explicit_cycling_watts": return explicitCyclingWatts(target.watts);
    case "ftp_fraction": return ftpTarget(target.fraction);
    case "cycling_zone": return { sport: "cycling", prescriptionKind: "power_zone", source: "profile_derived", zoneSystem: "coggan", zone: target.zone };
    case "explicit_swimming_pace": return explicitSwimmingPace(target.paceSecPer100m);
    case "swimming_threshold_offset": return swimmingThresholdOffset(target.offsetSecPer100m);
    case "swimming_zone": return swimmingZoneTarget(target.zone);
  }
}

function stepFromParsed(step: ParsedStep, sport: ParsedWorkout["sport"]): WorkoutStep {
  if (step.type === "repeat") {
    return {
      id: step.id,
      type: "repeat",
      repetitions: step.repetitions,
      steps: step.steps.map((child) => stepFromParsed(child, sport)),
      ...(step.notes === undefined ? {} : { notes: step.notes }),
    };
  }
  const runEffortZone = sport === "running" && step.type !== "rest" ? runningEffortZone(step.notes, step.duration) : undefined;
  const defaultTarget = sport === "running"
    ? runEffortZone !== undefined ? runningZoneTarget(runEffortZone) : isOpenRunningEffort(step.notes) ? undefined : defaultRunningTarget(step.type)
    : undefined;
  const openSwimEffort = sport === "swimming" && step.notes !== undefined && isOpenSwimEffort(step.notes);
  const effortZone = sport === "swimming" && step.type !== "rest" && step.target === undefined
    ? swimmingEffortZone(step.notes, step.duration)
    : undefined;
  const target = openSwimEffort
    ? undefined
    : step.target !== undefined
      ? targetFromParsed(step.target)
      : effortZone !== undefined
        ? swimmingZoneTarget(effortZone)
        : defaultTarget;
  return {
    id: step.id,
    type: step.type,
    duration: durationFromParsed(step.duration),
    ...(target === undefined ? {} : { target }),
    ...(step.notes === undefined ? {} : { notes: step.notes }),
  };
}

function applyProfileUpdates(profile: AthleteProfile, updates: ParsedWorkout["profileUpdates"], updatedAt: string): AthleteProfile {
  let next = profile;
  const metadata: UpdateMetadata = { source: "prompt", updatedAt };
  for (const update of updates) {
    if (update.kind === "running_threshold") next = updateRunningThreshold(next, update.thresholdPaceSecPerKm, metadata);
    if (update.kind === "cycling_ftp") next = updateCyclingFTP(next, update.ftpWatts, metadata);
    if (update.kind === "swimming_threshold") next = updateSwimmingThreshold(next, update.thresholdPaceSecPer100m, metadata);
  }
  return next;
}

function assertAtomicWorkoutSteps(steps: ParsedStep[]): void {
  for (const step of steps) {
    if (step.type === "repeat") {
      assertAtomicWorkoutSteps(step.steps);
      continue;
    }
    const notes = step.notes?.toLowerCase();
    if (step.type !== "rest" && notes !== undefined && /\brests?\b/.test(notes)) {
      throw new Error("A step described as rest must use the rest step type.");
    }
    if (notes === undefined || !notes.includes("+")) continue;
    const distanceMentions = notes.match(/\b\d+\s*(?:m|metres?|meters?|yds?|yards?)\b/g) ?? [];
    if (distanceMentions.length > 1 || /\brest\b/.test(notes)) {
      throw new Error("The model collapsed multiple workout components into one block. Each movement and rest must be a separate step.");
    }
  }
}

function explicitRepeatCounts(sourcePrompt: string): number[] {
  return [...sourcePrompt.matchAll(/\b([1-9]\d*)\s*(?:x|\u00d7)(?=\s|\()/gi)]
    .map((match) => Number(match[1]))
    .filter((repetitions) => repetitions > 1)
    .sort((left, right) => left - right);
}

function parsedRepeatCounts(steps: ParsedStep[]): number[] {
  const counts: number[] = [];
  for (const step of steps) {
    if (step.type !== "repeat") continue;
    counts.push(step.repetitions, ...parsedRepeatCounts(step.steps));
  }
  return counts.sort((left, right) => left - right);
}

function explicitTimedRestDurations(sourcePrompt: string): number[] {
  return [...sourcePrompt.matchAll(/\b(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|min)\s+rests?\b/gi)]
    .map((match) => Number(match[1]) * (/^min/i.test(match[2] ?? "") ? 60 : 1))
    .sort((left, right) => left - right);
}

function parsedTimedRestDurations(steps: ParsedStep[]): number[] {
  const durations: number[] = [];
  for (const step of steps) {
    if (step.type === "repeat") {
      durations.push(...parsedTimedRestDurations(step.steps));
    } else if (step.type === "rest" && step.duration.kind === "time") {
      durations.push(step.duration.seconds);
    }
  }
  return durations.sort((left, right) => left - right);
}

function normalizedSwimQualifiers(text: string): string[] {
  return [...text.matchAll(/\b(?:FS|freestyle|free|pull|drill|kick|choice|fins?|paddles?|snorkel|buoy)\b/gi)]
    .map((match) => {
      const qualifier = match[0]?.toLowerCase();
      if (qualifier === "fs" || qualifier === "free" || qualifier === "freestyle") return "freestyle";
      if (qualifier === "fin") return "fins";
      if (qualifier === "paddle") return "paddles";
      return qualifier ?? "";
    })
    .sort();
}

function parsedSwimQualifiers(steps: ParsedStep[]): string[] {
  const qualifiers: string[] = [];
  for (const step of steps) {
    if (step.type === "repeat") {
      qualifiers.push(...parsedSwimQualifiers(step.steps));
    } else if (step.notes !== undefined) {
      qualifiers.push(...normalizedSwimQualifiers(step.notes));
    }
  }
  return qualifiers.sort();
}

function semanticWarnings(steps: ParsedStep[], sourcePrompt: string, expectedRepeats?: number[]): string[] {
  const warnings: string[] = [];
  const requestedRepeats = expectedRepeats ?? explicitRepeatCounts(sourcePrompt);
  const parsedRepeats = parsedRepeatCounts(steps);
  if (requestedRepeats.join(",") !== parsedRepeats.join(",")) {
    warnings.push(`Repeat groups differ: ${expectedRepeats === undefined ? "requested" : "classic template"} ${requestedRepeats.join(", ") || "none"}; received ${parsedRepeats.join(", ") || "none"}.`);
  }

  const requestedRests = explicitTimedRestDurations(sourcePrompt);
  const parsedRests = parsedTimedRestDurations(steps);
  if (requestedRests.join(",") !== parsedRests.join(",")) {
    warnings.push(`Timed rests differ: requested ${requestedRests.join(", ") || "none"} sec; received ${parsedRests.join(", ") || "none"} sec.`);
  }

  const requestedQualifiers = normalizedSwimQualifiers(sourcePrompt);
  const parsedQualifiers = parsedSwimQualifiers(steps);
  if (requestedQualifiers.join(",") !== parsedQualifiers.join(",")) {
    warnings.push(`Swim notes differ: requested ${requestedQualifiers.join(", ") || "none"}; received ${parsedQualifiers.join(", ") || "none"}.`);
  }
  return warnings;
}

function hasExecutableStepType(steps: ParsedStep[], type: "warmup" | "cooldown"): boolean {
  return steps.some((step) => step.type === "repeat"
    ? hasExecutableStepType(step.steps, type)
    : step.type === type);
}

function sectionWarnings(steps: ParsedStep[], sourcePrompt: string): string[] {
  const warnings: string[] = [];
  const requestsWarmup = /\bwarm[\s-]*up\b/i.test(sourcePrompt);
  const requestsCooldown = /\b(?:warm[\s-]*down|cool[\s-]*down|cooldown)\b/i.test(sourcePrompt);
  if (requestsWarmup && !hasExecutableStepType(steps, "warmup")) {
    warnings.push("Requested warm-up is missing from the model workout.");
  }
  if (requestsCooldown && !hasExecutableStepType(steps, "cooldown")) {
    warnings.push("Requested cool-down is missing from the model workout.");
  }
  return warnings;
}

function parseModelWorkout(raw: unknown, selectedSport: Sport): ParsedWorkout {
  const parsed = parsedWorkoutSchema.parse(raw);
  if (parsed.sport !== selectedSport) {
    throw new Error(`The model returned ${parsed.sport}, but the selected sport is ${selectedSport}.`);
  }
  assertAtomicWorkoutSteps(parsed.steps);
  return parsed;
}

function buildWorkout(parsed: ParsedWorkout, sourcePrompt: string, now: string): Workout {
  const scheduledDate = parsed.scheduledDate ?? undefined;
  if (scheduledDate !== undefined) dateSchema.parse(scheduledDate);
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `workout-${Date.now()}`,
    name: parsed.name,
    sport: parsed.sport,
    ...(parsed.description === undefined ? {} : { description: parsed.description }),
    sourcePrompt,
    ...(scheduledDate === undefined ? {} : { scheduledDate }),
    createdAt: now,
    updatedAt: now,
    steps: parsed.steps.map((step) => stepFromParsed(step, parsed.sport)),
    resolutionWarnings: [],
  };
}

function fallbackExample(sport: Sport): { input: string; output: string } {
  if (sport === "cycling") {
    return {
      input: "Warm up 10 min in Z2, then 2 x (4 min at 105% FTP + 2 min recovery in Z1), then cool down 5 min in Z1.",
      output: `{"name":"Ride intervals","sport":"cycling","scheduledDate":null,"steps":[{"id":"warmup-1","type":"warmup","duration":{"kind":"time","seconds":600},"target":{"kind":"cycling_zone","zone":"endurance"}},{"id":"repeat-1","type":"repeat","repetitions":2,"steps":[{"id":"work-1","type":"work","duration":{"kind":"time","seconds":240},"target":{"kind":"ftp_fraction","fraction":1.05}},{"id":"recovery-1","type":"recovery","duration":{"kind":"time","seconds":120},"target":{"kind":"cycling_zone","zone":"recovery"}}]},{"id":"cooldown-1","type":"cooldown","duration":{"kind":"time","seconds":300},"target":{"kind":"cycling_zone","zone":"recovery"}}],"profileUpdates":[]}`,
    };
  }
  if (sport === "swimming") {
    return {
      input: "Swim 200 m FS in Z2, then 3 x (100 m Pull in Z4 + 20 sec rest), then finish with 100 m Choice in Z2.",
      output: `{"name":"Swim intervals","sport":"swimming","scheduledDate":null,"steps":[{"id":"warmup-1","type":"warmup","duration":{"kind":"distance","metres":200},"target":{"kind":"swimming_zone","zone":"z2_aerobic"},"notes":"FS"},{"id":"repeat-1","type":"repeat","repetitions":3,"steps":[{"id":"work-1","type":"work","duration":{"kind":"distance","metres":100},"target":{"kind":"swimming_zone","zone":"z4_threshold"},"notes":"Pull"},{"id":"rest-1","type":"rest","duration":{"kind":"time","seconds":20}}]},{"id":"cooldown-1","type":"cooldown","duration":{"kind":"distance","metres":100},"target":{"kind":"swimming_zone","zone":"z2_aerobic"},"notes":"Choice"}],"profileUpdates":[]}`,
    };
  }
  return {
    input: "Warm up 8 min in Z2, then 3 x (2 min in Z5 + 1 min recovery in Z1), then cool down 5 min in Z2.",
    output: `{"name":"Run intervals","sport":"running","scheduledDate":null,"steps":[{"id":"warmup-1","type":"warmup","duration":{"kind":"time","seconds":480},"target":{"kind":"running_zone","zone":"z2_aerobic"}},{"id":"repeat-1","type":"repeat","repetitions":3,"steps":[{"id":"work-1","type":"work","duration":{"kind":"time","seconds":120},"target":{"kind":"running_zone","zone":"z5_aggregate"}},{"id":"recovery-1","type":"recovery","duration":{"kind":"time","seconds":60},"target":{"kind":"running_zone","zone":"z1_recovery"}}]},{"id":"cooldown-1","type":"cooldown","duration":{"kind":"time","seconds":300},"target":{"kind":"running_zone","zone":"z2_aerobic"}}],"profileUpdates":[]}`,
  };
}

export const swimmingTestDayExample = {
  input: `Warm Up:
2 x (50 FS Easy + 20 sec rest).
TEST:
1 x 400 FS maximal effort time trial, RECORD TIME,
5 mins Easy for active recovery,
1 x 200 FS maximal effort time trial, RECORD TIME.
Main Set:
2 x (100 Pull at CSS + 5 sec/100m + 15 sec rest).
Warm Down:
100 Choice Easy.`,
  output: {
    name: "Swim CSS test day",
    sport: "swimming",
    scheduledDate: null,
    steps: [
      { id: "warmup-repeat", type: "repeat", repetitions: 2, steps: [
        { id: "warmup-fs", type: "warmup", duration: { kind: "distance", metres: 50 }, notes: "FS Easy" },
        { id: "warmup-rest", type: "rest", duration: { kind: "time", seconds: 20 } },
      ] },
      { id: "test-400", type: "work", duration: { kind: "distance", metres: 400 }, notes: "FS maximal effort time trial; RECORD TIME" },
      { id: "test-recovery", type: "recovery", duration: { kind: "time", seconds: 300 }, notes: "Easy active recovery" },
      { id: "test-200", type: "work", duration: { kind: "distance", metres: 200 }, notes: "FS maximal effort time trial; RECORD TIME" },
      { id: "main-repeat", type: "repeat", repetitions: 2, steps: [
        { id: "main-pull", type: "work", duration: { kind: "distance", metres: 100 }, target: { kind: "swimming_threshold_offset", offsetSecPer100m: 5 }, notes: "Pull" },
        { id: "main-rest", type: "rest", duration: { kind: "time", seconds: 15 } },
      ] },
      { id: "cooldown-choice", type: "cooldown", duration: { kind: "distance", metres: 100 }, notes: "Choice Easy" },
    ],
    profileUpdates: [],
  },
} as const;

function sportTargetRules(sport: Sport): string {
  if (sport === "cycling") {
    return `- Target kinds must be exactly: explicit_cycling_watts, ftp_fraction, or cycling_zone.
- Cycling zone values must be exactly: recovery, endurance, tempo, threshold, vo2max, or anaerobic.`;
  }
  if (sport === "swimming") {
    return `- Target kinds must be exactly: explicit_swimming_pace, swimming_threshold_offset, or swimming_zone. Never emit running pace or threshold-speed targets.
- Swimming zone targets use the Joe Friel for Swimming convention from TrainingPeaks. Values must be exactly z1_recovery, z2_aerobic, z3_tempo, z4_threshold, z5_aggregate, z5a_super_threshold, z5b_anaerobic_endurance, or z5c_power. Map plain Z5 to z5_aggregate.
- Preserve every swim execution qualifier in its own step notes, including FS, pull, drill, kick, choice, fins, paddles, snorkel, and buoy.
- In a TEST section, keep each distance-based time trial as a work step and preserve RECORD TIME in its notes. A timed active recovery is a separate recovery step. Do not invent a recorded time or update CSS from a prescribed test.
- Preserve effort words such as Easy, Steady, Hard, Moderately Hard, and Build Easy to Hard in step notes. The app maps unzoned Easy to Z1, Steady to Z2, Moderately Hard to Z3, short Hard to Z5a, longer Hard to Z4, and a short Sprint to Z5c. Leave Moderate, builds, and maximal-effort tests without a pace target; never invent a test result. Explicit zones and CSS prescriptions take priority.`;
  }
  return `- Target kinds must be exactly: explicit_running_pace, threshold_speed_fraction, or running_zone.
- Clock durations use H:MM:SS or M:SS: 1:45:00 is 6300 seconds. A pace like 06:00-06:40 min/km is an explicit_running_pace target with paceSecPerKm 360 and rangePaceSecPerKm [360,400]. Never replace an explicit pace range with a midpoint or zone target. An accompanying Zone 1-Zone 2 label stays in notes.
- Preserve qualitative running effort words in step notes. Without an explicit target, omit target so code applies reviewable effort defaults: Easy/Very Easy/active recovery to Z1, Steady/float to Z2, Moderately Hard/tempo to Z3, threshold to Z4. Hard maps to Z5a for at most 2 minutes or 400 m, otherwise Z4. Very Hard maps to Z5b for at most 1 minute or 200 m, otherwise Z5a. Sprint/All-out maps to Z5c only for at most 30 seconds or 100 m. Moderate, builds, progressive efforts and maximal-effort/time trials remain open; longer sprints also remain open. These are app heuristics, not published word-to-zone rules. Explicit pace, zone and threshold prescriptions take precedence.
- Running zone values must be exactly: z1_recovery, z2_aerobic, z3_tempo, z4_threshold, z5a_super_threshold, z5b_aerobic_capacity, z5c_anaerobic_capacity, or z5_aggregate. Map plain Z5 to z5_aggregate, Z5a to z5a_super_threshold, Z5b to z5b_aerobic_capacity, and Z5c to z5c_anaerobic_capacity. Do not use heart-rate percentages as pace multipliers.`;
}

function expectedStructureSummary(sourcePrompt: string, sport: Sport): string {
  const explicitCounts = explicitRepeatCounts(sourcePrompt);
  const counts = explicitCounts.length > 0 ? explicitCounts : namedTemplateRepeatCounts(sourcePrompt, sport) ?? [];
  return `Expected repeat counts: [${counts.join(", ")}], allowing explicitly requested modifications to a named template. Expected timed-rest seconds: [${explicitTimedRestDurations(sourcePrompt).join(", ")}]. Expected swim notes: [${normalizedSwimQualifiers(sourcePrompt).join(", ")}].`;
}

function promptFor(options: ParseWorkoutOptions, correction?: string): string {
  const example = fallbackExample(options.selectedSport);
  const swimTestExample = options.selectedSport === "swimming"
    ? `Swim TEST/CSS example input:
${swimmingTestDayExample.input}
Swim TEST/CSS example JSON (pattern only; do not copy its workout values):
${JSON.stringify(swimmingTestDayExample.output)}

`
    : "";
  return `Interpret the workout request into the exact JSON wire format below. Return JSON only, with no markdown and no alternate keys.

Selected sport: ${options.selectedSport}. The output sport must be exactly ${options.selectedSport}, even when the workout wording is ambiguous.

Example input (${options.selectedSport}): ${example.input}
Example JSON output (shape and nesting only; do not copy its workout values):
${example.output}

${swimTestExample}${templateInstructions(options.sourcePrompt, options.selectedSport)}
Rules:
- The sport must match the selected sport above. Do not infer or substitute another sport.
- Use only these step types: warmup, work, recovery, cooldown, rest, or a repeat object with type repeat, repetitions, and nested steps.
- Preserve every named section. Every active movement under a "Warm Up" or "Warm-up" heading must be emitted with type warmup. Every active movement under "Warm Down", "Cool Down", or "Cooldown" must be emitted with type cooldown. A rest instruction always uses type rest regardless of its section. Main Set movements use work, recovery, or rest as appropriate. Never omit a section because it contains a 1 x group.
- Every movement and rest separated by a plus sign (+), comma, or the word "then" must be a separate step. For "100 FS + 100 Pull + 10 sec rest", emit three nested steps: one 100-distance FS step, one 100-distance Pull step, and one 10-second rest step. The plus in "CSS + 5 sec/100m" is arithmetic inside one target, not a step separator.
- Notes describe only their own atomic step. Use notes such as "FS", "pull", "drill", or "choice". Never copy multiple distances, a plus-separated sequence, or a rest instruction into one step's notes.
- Create one repeat object for every explicit "N x (...)" or "N x distance" group where N is greater than 1, and set repetitions to exactly N. Do not expand repetitions into duplicated steps. Never combine adjacent repeat groups because their zones, strokes, or rest durations may differ. A "1 x (...)" group may be flattened to its component steps, but its components must remain separate.
- Duration kinds are time with seconds, distance with metres, lap, or open.
- Use explicit targets for exact pace or watts. Use profile-derived target kinds for threshold, running zones, FTP fractions, cycling zones, and CSS offsets.
${sportTargetRules(options.selectedSport)}
- Do not calculate resolved pace, watts, or CSS values. The application does that deterministically.
- Reference date is ${options.referenceDate} in timezone ${options.timeZone}. Resolve tomorrow and weekdays from that reference. Use null when no date is present.
- profileUpdates must always be an array. Never invent a baseline; include an update only when the user explicitly states a new one.
${correction === undefined ? "" : `\nCorrection: ${correction}`}`;
}

export async function parseWorkout(options: ParseWorkoutOptions): Promise<ParseWorkoutResult> {
  const request = async (correction?: string): Promise<unknown> => options.provider.generateStructured({
    messages: [
      { role: "system", content: promptFor(options, correction) },
      { role: "user", content: `Selected sport: ${options.selectedSport}\n\nWorkout request:\n${options.sourcePrompt}` },
    ],
    jsonSchema: parsedWorkoutJsonSchemaForSport(options.selectedSport),
    temperature: 0,
    maxTokens: 3072,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  let parsed: ParsedWorkout;
  const named = parseNamedWorkout(options.sourcePrompt, options.selectedSport, options.referenceDate);
  const structured = named ?? (options.selectedSport === "swimming"
    ? parseStructuredSwim(options.sourcePrompt)
    : parseStructuredEndurance(options.sourcePrompt, options.selectedSport));
  if (structured !== undefined) {
    parsed = parseModelWorkout(structured, options.selectedSport);
  } else {
    try {
      const raw = await request();
      parsed = parseModelWorkout(raw, options.selectedSport);
    } catch (firstError) {
      try {
        const raw = await request(`The previous response failed or was truncated. Return one concise JSON object only. The sport must be exactly ${options.selectedSport}. ${expectedStructureSummary(options.sourcePrompt, options.selectedSport)} Return the exact top-level keys name, sport, scheduledDate, steps, and profileUpdates. profileUpdates must be [] when there are no updates. Do not use structure, date, recovery, warmup, or cooldown as top-level alternatives. Include every Warm Up and Warm Down/Cooldown section as executable steps with type warmup or cooldown, including sections written as 1 x (...). A rest instruction must always have type rest. Keep every plus-separated movement and rest as its own atomic step; never summarize multiple distances or a rest inside one notes field. Preserve every explicit repeat greater than 1 as its own repeat object with the exact repetition count; never expand it into duplicated steps or merge adjacent repeat groups.`);
        parsed = parseModelWorkout(raw, options.selectedSport);
      } catch (retryError) {
        throw new Error(`Model interpretation failed twice. First: ${errorMessage(firstError)} Retry: ${errorMessage(retryError)}`);
      }
    }
  }
  const now = new Date().toISOString();
  const updatedProfile = applyProfileUpdates(options.profile, parsed.profileUpdates, now);
  const unresolved = buildWorkout(parsed, options.sourcePrompt, now);
  const resolved = resolveWorkoutTargets(unresolved, updatedProfile);
  return {
    workout: resolved.workout,
    profile: updatedProfile,
    warnings: resolved.warnings,
    interpretationWarnings: [
      ...semanticWarnings(parsed.steps, options.sourcePrompt, explicitRepeatCounts(options.sourcePrompt).length === 0 ? namedTemplateRepeatCounts(options.sourcePrompt, options.selectedSport) : undefined),
      ...sectionWarnings(parsed.steps, options.sourcePrompt),
    ],
  };
}
