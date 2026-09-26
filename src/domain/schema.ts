import { z } from "zod";

// The canonical model is deliberately independent of Garmin, FIT, UI, and LLM payloads.

const positiveNumber = z.number().finite().positive();
const nonNegativeNumber = z.number().finite().nonnegative();

export const sportSchema = z.enum(["running", "cycling", "swimming"]);
export type Sport = z.infer<typeof sportSchema>;

export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

export const durationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("time"), seconds: positiveNumber }),
  z.object({ kind: z.literal("distance"), metres: positiveNumber }),
  z.object({ kind: z.literal("lap") }),
  z.object({ kind: z.literal("open") }),
]);
export type Duration = z.infer<typeof durationSchema>;

const runningResolvedSchema = z.object({
  kind: z.literal("running_pace"),
  paceSecPerKm: positiveNumber,
  rangePaceSecPerKm: z.tuple([positiveNumber, positiveNumber]).optional(),
});
const cyclingResolvedSchema = z.object({
  kind: z.literal("cycling_power"),
  watts: positiveNumber,
  rangeWatts: z.tuple([positiveNumber, positiveNumber]).optional(),
});
const swimmingResolvedSchema = z.object({
  kind: z.literal("swimming_pace"),
  paceSecPer100m: positiveNumber,
  rangePaceSecPer100m: z.tuple([positiveNumber, positiveNumber]).optional(),
});

export const runningTargetSchema = z.discriminatedUnion("prescriptionKind", [
  z.object({
    sport: z.literal("running"),
    prescriptionKind: z.literal("explicit_pace"),
    source: z.literal("explicit"),
    paceSecPerKm: positiveNumber,
    resolved: runningResolvedSchema,
  }),
  z.object({
    sport: z.literal("running"),
    prescriptionKind: z.literal("threshold_speed_fraction"),
    source: z.literal("profile_derived"),
    fraction: z.number().finite().positive(),
    resolved: runningResolvedSchema.optional(),
  }),
  z.object({
    sport: z.literal("running"),
    prescriptionKind: z.literal("pace_zone"),
    source: z.literal("profile_derived"),
    zoneSystem: z.literal("friel_trainingpeaks"),
    zone: z.enum(["z1_recovery", "z2_aerobic", "z3_tempo", "z4_threshold", "z5_anaerobic"]),
    resolved: runningResolvedSchema.optional(),
  }),
]);
export type RunningTarget = z.infer<typeof runningTargetSchema>;

export const cyclingTargetSchema = z.discriminatedUnion("prescriptionKind", [
  z.object({
    sport: z.literal("cycling"),
    prescriptionKind: z.literal("explicit_watts"),
    source: z.literal("explicit"),
    watts: positiveNumber,
    resolved: cyclingResolvedSchema,
  }),
  z.object({
    sport: z.literal("cycling"),
    prescriptionKind: z.literal("ftp_fraction"),
    source: z.literal("profile_derived"),
    fraction: z.number().finite().positive(),
    resolved: cyclingResolvedSchema.optional(),
  }),
  z.object({
    sport: z.literal("cycling"),
    prescriptionKind: z.literal("power_zone"),
    source: z.literal("profile_derived"),
    zoneSystem: z.literal("coggan"),
    zone: z.enum(["recovery", "endurance", "tempo", "threshold", "vo2max", "anaerobic"]),
    resolved: cyclingResolvedSchema.optional(),
  }),
]);
export type CyclingTarget = z.infer<typeof cyclingTargetSchema>;

export const swimmingTargetSchema = z.discriminatedUnion("prescriptionKind", [
  z.object({
    sport: z.literal("swimming"),
    prescriptionKind: z.literal("explicit_pace"),
    source: z.literal("explicit"),
    paceSecPer100m: positiveNumber,
    resolved: swimmingResolvedSchema,
  }),
  z.object({
    sport: z.literal("swimming"),
    prescriptionKind: z.literal("threshold_offset"),
    source: z.literal("profile_derived"),
    offsetSecPer100m: z.number().finite(),
    resolved: swimmingResolvedSchema.optional(),
  }),
]);
export type SwimmingTarget = z.infer<typeof swimmingTargetSchema>;

export const targetSchema = z.union([
  runningTargetSchema,
  cyclingTargetSchema,
  swimmingTargetSchema,
]);
export type Target = z.infer<typeof targetSchema>;

const executableStepBase = z.object({
  id: z.string().min(1),
  type: z.enum(["warmup", "work", "recovery", "cooldown", "rest"]),
  duration: durationSchema,
  target: targetSchema.optional(),
  notes: z.string().min(1).optional(),
});

export type ExecutableStep = {
  id: string;
  type: "warmup" | "work" | "recovery" | "cooldown" | "rest";
  duration: Duration;
  target?: Target | undefined;
  notes?: string | undefined;
};
export type RepeatStep = {
  id: string;
  type: "repeat";
  repetitions: number;
  steps: WorkoutStep[];
  notes?: string | undefined;
};
export type WorkoutStep = ExecutableStep | RepeatStep;

export const executableStepSchema: z.ZodType<ExecutableStep> = executableStepBase;
export const repeatStepSchema: z.ZodType<RepeatStep> = z.lazy(() =>
  z.object({
    id: z.string().min(1),
    type: z.literal("repeat"),
    repetitions: z.number().int().positive(),
    steps: z.array(z.union([executableStepSchema, repeatStepSchema])).min(1),
    notes: z.string().min(1).optional(),
  }),
);
export const workoutStepSchema = z.union([executableStepSchema, repeatStepSchema]);

const baselineMetadataSchema = z.object({
  value: positiveNumber,
  source: z.enum(["manual", "prompt", "imported"]),
  updatedAt: z.string().datetime({ offset: true }),
});

export const athleteProfileSchema = z.object({
  id: z.string().min(1),
  running: z.object({
    thresholdPaceSecPerKm: baselineMetadataSchema.optional(),
    thresholdHeartRateBpm: baselineMetadataSchema.optional(),
    paceZoneSystem: z.literal("friel_trainingpeaks"),
  }),
  cycling: z.object({
    ftpWatts: baselineMetadataSchema.optional(),
    thresholdHeartRateBpm: baselineMetadataSchema.optional(),
    powerZoneSystem: z.literal("coggan"),
  }),
  swimming: z.object({
    thresholdPaceSecPer100m: baselineMetadataSchema.optional(),
    thresholdMethod: z.enum(["css", "t_time", "user_defined"]),
    poolLengthMeters: positiveNumber.optional(),
  }),
});
export type AthleteProfile = z.infer<typeof athleteProfileSchema>;

export const profileSnapshotSchema = athleteProfileSchema.partial();

export const resolutionWarningSchema = z.object({
  code: z.enum([
    "RUNNING_THRESHOLD_PACE_REQUIRED",
    "CYCLING_FTP_REQUIRED",
    "SWIMMING_THRESHOLD_PACE_REQUIRED",
  ]),
  stepId: z.string().min(1),
  message: z.string().min(1),
});
export type ResolutionWarning = z.infer<typeof resolutionWarningSchema>;

export const workoutSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  sport: sportSchema,
  description: z.string().min(1).optional(),
  sourcePrompt: z.string().min(1).optional(),
  scheduledDate: dateSchema.optional(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  steps: z.array(workoutStepSchema).min(1),
  profileSnapshot: profileSnapshotSchema.optional(),
  resolutionWarnings: z.array(resolutionWarningSchema),
});
export type Workout = z.infer<typeof workoutSchema>;
