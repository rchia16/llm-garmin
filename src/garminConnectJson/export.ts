import { workoutSchema, type AthleteProfile, type Workout, type WorkoutStep } from "../domain/index.js";
import { runningPaceLabel } from "../engine/running.js";

type GarminEnum = Record<string, string | number | boolean>;
type GarminStep = Record<string, unknown>;

export type GarminConnectJsonExport = { workout: Record<string, unknown>; warnings: string[] };

const sportTypes = {
  running: { sportTypeId: 1, sportTypeKey: "running", displayOrder: 1 },
  cycling: { sportTypeId: 2, sportTypeKey: "cycling", displayOrder: 2 },
  swimming: { sportTypeId: 4, sportTypeKey: "swimming", displayOrder: 3 },
} as const;

const stepTypes = {
  warmup: { stepTypeId: 1, stepTypeKey: "warmup", displayOrder: 1 },
  cooldown: { stepTypeId: 2, stepTypeKey: "cooldown", displayOrder: 2 },
  work: { stepTypeId: 3, stepTypeKey: "interval", displayOrder: 3 },
  recovery: { stepTypeId: 4, stepTypeKey: "recovery", displayOrder: 4 },
  rest: { stepTypeId: 5, stepTypeKey: "rest", displayOrder: 5 },
  repeat: { stepTypeId: 6, stepTypeKey: "repeat", displayOrder: 6 },
} as const;

const noTarget = { workoutTargetTypeId: 1, workoutTargetTypeKey: "no.target", displayOrder: 1 };
const powerTarget = { workoutTargetTypeId: 2, workoutTargetTypeKey: "power.zone", displayOrder: 2 };
const paceTarget = { workoutTargetTypeId: 6, workoutTargetTypeKey: "pace.zone", displayOrder: 6 };

function endCondition(id: number, key: string, displayable = true): GarminEnum {
  return { conditionTypeId: id, conditionTypeKey: key, displayOrder: id, displayable };
}

function strokeType(notes: string | undefined): GarminEnum {
  if (notes !== undefined && /\b(?:freestyle|free|fs|pull)\b/i.test(notes)) {
    return { strokeTypeId: 6, strokeTypeKey: "free", displayOrder: 6 };
  }
  return { strokeTypeId: 1, strokeTypeKey: "any_stroke", displayOrder: 1 };
}

function durationFields(step: Exclude<WorkoutStep, { type: "repeat" }>, warnings: string[], sport: Workout["sport"]): GarminStep {
  switch (step.duration.kind) {
    case "time":
      if (sport === "swimming" && step.type !== "rest") warnings.push(`Step ${step.id}: check time-based swim steps in Garmin Connect; pool-swim support varies.`);
      return { endCondition: endCondition(2, "time"), endConditionValue: step.duration.seconds };
    case "distance":
      return { endCondition: endCondition(3, "distance"), endConditionValue: step.duration.metres, preferredEndConditionUnit: { unitKey: "meter" } };
    case "lap":
      return { endCondition: endCondition(1, "lap.button") };
    case "open":
      warnings.push(`Step ${step.id}: open duration uses the lap button in Garmin Connect.`);
      return { endCondition: endCondition(1, "lap.button") };
  }
}

function targetFields(step: Exclude<WorkoutStep, { type: "repeat" }>, sport: Workout["sport"], warnings: string[]): GarminStep {
  const target = step.target;
  if (target === undefined) return { targetType: noTarget };
  if (target.sport !== sport) throw new Error(`Step ${step.id} has a ${target.sport} target in a ${sport} workout.`);
  if (target.source === "profile_derived" && target.resolved === undefined) {
    throw new Error(`Step ${step.id} needs a profile baseline before Garmin Connect JSON export.`);
  }
  const resolved = target.resolved;
  if (resolved?.kind === "running_pace" && resolved.paceBoundary !== undefined) {
    warnings.push(`Step ${step.id}: open-ended running pace is a written cue only.`);
    return { targetType: noTarget };
  }
  if (resolved?.kind === "running_pace" || resolved?.kind === "swimming_pace") {
    const pace = resolved.kind === "running_pace" ? resolved.paceSecPerKm : resolved.paceSecPer100m;
    const range = resolved.kind === "running_pace" ? resolved.rangePaceSecPerKm : resolved.rangePaceSecPer100m;
    const metres = sport === "running" ? 1000 : 100;
    const fields = {
      targetValueOne: metres / (range?.[0] ?? pace),
      targetValueTwo: metres / (range?.[1] ?? pace),
    };
    // Garmin pool workouts use stroke as the primary instruction and pace as secondary.
    return sport === "swimming"
      ? { targetType: noTarget, secondaryTargetType: paceTarget, secondaryTargetValueOne: fields.targetValueOne, secondaryTargetValueTwo: fields.targetValueTwo }
      : { targetType: paceTarget, ...fields };
  }
  if (resolved?.kind === "cycling_power") {
    if (target.sport === "cycling" && target.prescriptionKind === "power_zone") {
      const zoneNumber = { recovery: 1, endurance: 2, tempo: 3, threshold: 4, vo2max: 5, anaerobic: 6 }[target.zone];
      return { targetType: powerTarget, zoneNumber };
    }
    const range = resolved.rangeWatts ?? [resolved.watts, resolved.watts];
    warnings.push(`Step ${step.id}: verify custom watt targets after import; Garmin Connect may change their target type.`);
    return { targetType: powerTarget, targetValueOne: range[0], targetValueTwo: range[1] };
  }
  throw new Error(`Step ${step.id} has no resolved target for Garmin Connect JSON export.`);
}

export function exportGarminConnectJson(workout: Workout, profile?: AthleteProfile): GarminConnectJsonExport {
  const validated = workoutSchema.parse(workout);
  const warnings: string[] = [];
  const sportType = sportTypes[validated.sport];
  let hasSwimPaceTarget = false;
  let stepOrder = 0;
  const visit = (steps: WorkoutStep[]): GarminStep[] => steps.map((step): GarminStep => {
    stepOrder += 1;
    const order = stepOrder;
    if (step.type === "repeat") {
      return {
        type: "RepeatGroupDTO", stepId: null, stepOrder: order, stepType: stepTypes.repeat,
        numberOfIterations: step.repetitions, smartRepeat: false,
        endCondition: endCondition(7, "iterations", false), endConditionValue: step.repetitions,
        workoutSteps: visit(step.steps),
        ...(step.notes === undefined ? {} : { description: step.notes }),
      };
    }
    if (validated.sport === "swimming" && step.target?.resolved?.kind === "swimming_pace") hasSwimPaceTarget = true;
    return {
      type: "ExecutableStepDTO", stepId: null, stepOrder: order,
      stepType: validated.sport === "swimming" && step.type === "work"
        ? { stepTypeId: 8, stepTypeKey: "main", displayOrder: 8 }
        : stepTypes[step.type],
      ...durationFields(step, warnings, validated.sport),
      ...targetFields(step, validated.sport, warnings),
      ...(step.target?.resolved?.kind === "running_pace" && step.target.resolved.paceBoundary !== undefined
        ? { description: [step.notes, `Running pace ${runningPaceLabel(step.target.resolved)}`].filter(Boolean).join("; ") }
        : step.notes === undefined ? {} : { description: step.notes }),
      ...(validated.sport === "swimming" && step.type !== "rest" ? { strokeType: strokeType(step.notes) } : {}),
    };
  });
  const exported: Record<string, unknown> = {
    workoutName: validated.name,
    sportType,
    workoutSegments: [{ segmentOrder: 1, sportType, workoutSteps: visit(validated.steps) }],
  };
  if (validated.description !== undefined) exported.description = validated.description;
  if (validated.sport === "swimming" && profile?.swimming.poolLengthMeters !== undefined) {
    exported.poolLength = profile.swimming.poolLengthMeters;
    exported.poolLengthUnit = { unitKey: "meter" };
  }
  if (hasSwimPaceTarget) warnings.push("Swim pace is exported as a secondary target; verify it in Garmin Connect and on your device.");
  return { workout: exported, warnings };
}
