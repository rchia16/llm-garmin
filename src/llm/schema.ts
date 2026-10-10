import { z } from "zod";
import { runningZoneNames } from "../domain/index.js";

// The model emits semantic intent only. Numeric target resolution remains in the deterministic engine.
const cyclingZoneNames = ["recovery", "endurance", "tempo", "threshold", "vo2max", "anaerobic"] as const;
const swimmingZoneNames = [
  "z1_recovery",
  "z2_aerobic",
  "z3_tempo",
  "z4_threshold",
  "z5_aggregate",
  "z5a_super_threshold",
  "z5b_anaerobic_endurance",
  "z5c_power",
] as const;

function normalizeZoneAlias(value: unknown, aliases: Readonly<Record<string, string>>): unknown {
  if (typeof value !== "string" && typeof value !== "number") return value;
  const normalized = String(value).trim().toLowerCase().replace(/[\s_-]+/g, "");
  return aliases[normalized] ?? value;
}

const runningZoneSchema = z.preprocess(
  (value) => normalizeZoneAlias(value, {
    "1": "z1_recovery", z1: "z1_recovery", zone1: "z1_recovery", z1recovery: "z1_recovery",
    "2": "z2_aerobic", z2: "z2_aerobic", zone2: "z2_aerobic", z2aerobic: "z2_aerobic",
    "3": "z3_tempo", z3: "z3_tempo", zone3: "z3_tempo", z3tempo: "z3_tempo",
    "4": "z4_threshold", z4: "z4_threshold", zone4: "z4_threshold", z4threshold: "z4_threshold",
    "5": "z5_aggregate", z5: "z5_aggregate", zone5: "z5_aggregate", z5anaerobic: "z5_aggregate",
    "5a": "z5a_super_threshold", z5a: "z5a_super_threshold", zone5a: "z5a_super_threshold", z5asuperthreshold: "z5a_super_threshold",
    "5b": "z5b_aerobic_capacity", z5b: "z5b_aerobic_capacity", zone5b: "z5b_aerobic_capacity", z5baerobiccapacity: "z5b_aerobic_capacity",
    "5c": "z5c_anaerobic_capacity", z5c: "z5c_anaerobic_capacity", zone5c: "z5c_anaerobic_capacity", z5canaerobiccapacity: "z5c_anaerobic_capacity",
  }),
  z.enum(runningZoneNames),
);

const cyclingZoneSchema = z.preprocess(
  (value) => normalizeZoneAlias(value, {
    "1": "recovery", z1: "recovery", zone1: "recovery",
    "2": "endurance", z2: "endurance", zone2: "endurance",
    "3": "tempo", z3: "tempo", zone3: "tempo",
    "4": "threshold", z4: "threshold", zone4: "threshold",
    "5": "vo2max", z5: "vo2max", zone5: "vo2max", vo2: "vo2max",
    "6": "anaerobic", z6: "anaerobic", zone6: "anaerobic",
  }),
  z.enum(cyclingZoneNames),
);

const swimmingZoneSchema = z.preprocess(
  (value) => normalizeZoneAlias(value, {
    "1": "z1_recovery", z1: "z1_recovery", zone1: "z1_recovery", z1recovery: "z1_recovery",
    "2": "z2_aerobic", z2: "z2_aerobic", zone2: "z2_aerobic", z2aerobic: "z2_aerobic",
    "3": "z3_tempo", z3: "z3_tempo", zone3: "z3_tempo", z3tempo: "z3_tempo",
    "4": "z4_threshold", z4: "z4_threshold", zone4: "z4_threshold", z4threshold: "z4_threshold",
    "5": "z5_aggregate", z5: "z5_aggregate", zone5: "z5_aggregate",
    "5a": "z5a_super_threshold", z5a: "z5a_super_threshold", zone5a: "z5a_super_threshold", z5asuperthreshold: "z5a_super_threshold",
    "5b": "z5b_anaerobic_endurance", z5b: "z5b_anaerobic_endurance", zone5b: "z5b_anaerobic_endurance", z5banaerobicendurance: "z5b_anaerobic_endurance",
    "5c": "z5c_power", z5c: "z5c_power", zone5c: "z5c_power", z5cpower: "z5c_power",
  }),
  z.enum(swimmingZoneNames),
);

const parsedDurationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("time"), seconds: z.number().finite().positive() }),
  z.object({ kind: z.literal("distance"), metres: z.number().finite().positive() }),
  z.object({ kind: z.literal("lap") }),
  z.object({ kind: z.literal("open") }),
]);

const parsedTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("explicit_running_pace"), paceSecPerKm: z.number().finite().positive(), rangePaceSecPerKm: z.tuple([z.number().finite().positive(), z.number().finite().positive()]).refine(([fast, slow]) => fast <= slow, "Pace range must be ordered from faster to slower.").optional() }),
  z.object({ kind: z.literal("threshold_speed_fraction"), fraction: z.number().finite().positive() }),
  z.object({ kind: z.literal("running_zone"), zone: runningZoneSchema }),
  z.object({ kind: z.literal("explicit_cycling_watts"), watts: z.number().finite().positive() }),
  z.object({ kind: z.literal("ftp_fraction"), fraction: z.number().finite().positive() }),
  z.object({ kind: z.literal("cycling_zone"), zone: cyclingZoneSchema }),
  z.object({ kind: z.literal("explicit_swimming_pace"), paceSecPer100m: z.number().finite().positive() }),
  z.object({ kind: z.literal("swimming_threshold_offset"), offsetSecPer100m: z.number().finite() }),
  z.object({ kind: z.literal("swimming_zone"), zone: swimmingZoneSchema }),
]);

export type ParsedTarget = z.infer<typeof parsedTargetSchema>;
export type ParsedDuration = z.infer<typeof parsedDurationSchema>;
export type ParsedStep = {
  id: string;
  type: "warmup" | "work" | "recovery" | "cooldown" | "rest";
  duration: ParsedDuration;
  target?: ParsedTarget | undefined;
  notes?: string | undefined;
} | {
  id: string;
  type: "repeat";
  repetitions: number;
  steps: ParsedStep[];
  notes?: string | undefined;
};

const parsedStepSchema: z.ZodType<ParsedStep, z.ZodTypeDef, unknown> = z.lazy(() => z.union([
  z.object({
    id: z.string().min(1),
    type: z.enum(["warmup", "work", "recovery", "cooldown", "rest"]),
    duration: parsedDurationSchema,
    target: parsedTargetSchema.optional(),
    notes: z.string().min(1).optional(),
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal("repeat"),
    repetitions: z.number().int().positive(),
    steps: z.array(parsedStepSchema).min(1),
    notes: z.string().min(1).optional(),
  }),
])) ;

export const profileUpdateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("running_threshold"), thresholdPaceSecPerKm: z.number().finite().positive() }),
  z.object({ kind: z.literal("cycling_ftp"), ftpWatts: z.number().finite().positive() }),
  z.object({ kind: z.literal("swimming_threshold"), thresholdPaceSecPer100m: z.number().finite().positive() }),
]);

export const parsedWorkoutSchema = z.object({
  name: z.string().min(1),
  sport: z.enum(["running", "cycling", "swimming"]),
  description: z.string().min(1).optional(),
  scheduledDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  steps: z.array(parsedStepSchema).min(1),
  profileUpdates: z.array(profileUpdateSchema).default([]),
});
export type ParsedWorkout = z.infer<typeof parsedWorkoutSchema>;

const runningTargetJsonSchemas = [
  { properties: { kind: { const: "explicit_running_pace" }, paceSecPerKm: { type: "number", exclusiveMinimum: 0 }, rangePaceSecPerKm: { type: "array", minItems: 2, maxItems: 2, items: { type: "number", exclusiveMinimum: 0 } } }, required: ["kind", "paceSecPerKm"] },
  { properties: { kind: { const: "threshold_speed_fraction" }, fraction: { type: "number", exclusiveMinimum: 0 } }, required: ["kind", "fraction"] },
  { properties: { kind: { const: "running_zone" }, zone: { type: "string", enum: runningZoneNames } }, required: ["kind", "zone"] },
] as const;

const cyclingTargetJsonSchemas = [
  { properties: { kind: { const: "explicit_cycling_watts" }, watts: { type: "number", exclusiveMinimum: 0 } }, required: ["kind", "watts"] },
  { properties: { kind: { const: "ftp_fraction" }, fraction: { type: "number", exclusiveMinimum: 0 } }, required: ["kind", "fraction"] },
  { properties: { kind: { const: "cycling_zone" }, zone: { type: "string", enum: cyclingZoneNames } }, required: ["kind", "zone"] },
] as const;

const swimmingTargetJsonSchemas = [
  { properties: { kind: { const: "explicit_swimming_pace" }, paceSecPer100m: { type: "number", exclusiveMinimum: 0 } }, required: ["kind", "paceSecPer100m"] },
  { properties: { kind: { const: "swimming_threshold_offset" }, offsetSecPer100m: { type: "number" } }, required: ["kind", "offsetSecPer100m"] },
  { properties: { kind: { const: "swimming_zone" }, zone: { type: "string", enum: swimmingZoneNames } }, required: ["kind", "zone"] },
] as const;

const runningProfileUpdateJsonSchema = { properties: { kind: { const: "running_threshold" }, thresholdPaceSecPerKm: { type: "number", exclusiveMinimum: 0 } }, required: ["kind", "thresholdPaceSecPerKm"] } as const;
const cyclingProfileUpdateJsonSchema = { properties: { kind: { const: "cycling_ftp" }, ftpWatts: { type: "number", exclusiveMinimum: 0 } }, required: ["kind", "ftpWatts"] } as const;
const swimmingProfileUpdateJsonSchema = { properties: { kind: { const: "swimming_threshold" }, thresholdPaceSecPer100m: { type: "number", exclusiveMinimum: 0 } }, required: ["kind", "thresholdPaceSecPer100m"] } as const;

function createParsedWorkoutJsonSchema(
  sportSchema: { readonly enum: readonly string[] } | { readonly const: string },
  targetSchemas: readonly object[],
  profileUpdateSchemas: readonly object[],
) {
  return {
  type: "object",
  additionalProperties: false,
  $defs: {
    duration: {
      type: "object",
      oneOf: [
        { properties: { kind: { const: "time" }, seconds: { type: "number", exclusiveMinimum: 0 } }, required: ["kind", "seconds"] },
        { properties: { kind: { const: "distance" }, metres: { type: "number", exclusiveMinimum: 0 } }, required: ["kind", "metres"] },
        { properties: { kind: { const: "lap" } }, required: ["kind"] },
        { properties: { kind: { const: "open" } }, required: ["kind"] },
      ],
    },
    target: {
      type: "object",
      oneOf: targetSchemas,
    },
    step: {
      oneOf: [
        {
          type: "object",
          properties: {
            id: { type: "string" },
            type: { enum: ["warmup", "work", "recovery", "cooldown", "rest"] },
            duration: { $ref: "#/$defs/duration" },
            target: { $ref: "#/$defs/target" },
            notes: { type: "string" },
          },
          required: ["id", "type", "duration"],
        },
        {
          type: "object",
          properties: {
            id: { type: "string" },
            type: { const: "repeat" },
            repetitions: { type: "integer", minimum: 1 },
            steps: { type: "array", items: { $ref: "#/$defs/step" }, minItems: 1 },
            notes: { type: "string" },
          },
          required: ["id", "type", "repetitions", "steps"],
        },
      ],
    },
    profileUpdate: {
      oneOf: profileUpdateSchemas,
    },
  },
  required: ["name", "sport", "steps", "profileUpdates"],
  properties: {
    name: { type: "string" },
    sport: { type: "string", ...sportSchema },
    description: { type: ["string", "null"] },
    scheduledDate: { type: ["string", "null"] },
    steps: { type: "array", items: { $ref: "#/$defs/step" }, minItems: 1 },
    profileUpdates: { type: "array", items: { $ref: "#/$defs/profileUpdate" } },
  },
  } as const;
}

export const parsedWorkoutJsonSchema = createParsedWorkoutJsonSchema(
  { enum: ["running", "cycling", "swimming"] },
  [...runningTargetJsonSchemas, ...cyclingTargetJsonSchemas, ...swimmingTargetJsonSchemas],
  [runningProfileUpdateJsonSchema, cyclingProfileUpdateJsonSchema, swimmingProfileUpdateJsonSchema],
);

export function parsedWorkoutJsonSchemaForSport(sport: ParsedWorkout["sport"]) {
  if (sport === "running") {
    return createParsedWorkoutJsonSchema({ const: sport }, runningTargetJsonSchemas, [runningProfileUpdateJsonSchema]);
  }
  if (sport === "cycling") {
    return createParsedWorkoutJsonSchema({ const: sport }, cyclingTargetJsonSchemas, [cyclingProfileUpdateJsonSchema]);
  }
  return createParsedWorkoutJsonSchema({ const: sport }, swimmingTargetJsonSchemas, [swimmingProfileUpdateJsonSchema]);
}
