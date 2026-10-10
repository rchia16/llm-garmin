import { Decoder, Encoder, Profile, Stream } from "@garmin/fitsdk";
import type { FileIdMesg, WorkoutMesg, WorkoutStepMesg } from "@garmin/fitsdk";
import { workoutSchema, type Workout, type WorkoutStep } from "../domain/index.js";
import { runningPaceLabel } from "../engine/running.js";

export type FitExport = { bytes: Uint8Array; warnings: string[] };

function serialNumber(id: string): number {
  let hash = 2166136261;
  for (const character of id) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return (hash >>> 0) || 1;
}

function strokeFromNotes(notes: string | undefined): string | undefined {
  if (notes === undefined) return undefined;
  if (/\b(?:drill|kick)\b/i.test(notes)) return "drill";
  if (/\b(?:choice|mixed|im)\b/i.test(notes)) return "mixed";
  if (/\b(?:backstroke|back)\b/i.test(notes)) return "backstroke";
  if (/\b(?:breaststroke|breast)\b/i.test(notes)) return "breaststroke";
  if (/\b(?:butterfly|fly)\b/i.test(notes)) return "butterfly";
  if (/\b(?:freestyle|free|fs|pull)\b/i.test(notes)) return "freestyle";
  return undefined;
}

function durationFields(step: Exclude<WorkoutStep, { type: "repeat" }>): Pick<WorkoutStepMesg, "durationType" | "durationValue"> {
  if (step.duration.kind === "time") return { durationType: 0, durationValue: Math.round(step.duration.seconds * 1000) };
  if (step.duration.kind === "distance") return { durationType: 1, durationValue: Math.round(step.duration.metres * 100) };
  // Both open and lap-button steps advance manually in FIT.
  return { durationType: 5, durationValue: 0 };
}

function intensity(type: Exclude<WorkoutStep, { type: "repeat" }>["type"]): number {
  return { warmup: 2, work: 0, recovery: 4, cooldown: 3, rest: 1 }[type];
}

function targetFields(step: Exclude<WorkoutStep, { type: "repeat" }>, sport: Workout["sport"], warnings: string[]): Pick<WorkoutStepMesg, "targetType" | "targetValue" | "customTargetValueLow" | "customTargetValueHigh" | "notes"> {
  const target = step.target;
  if (target !== undefined && target.sport !== sport) {
    throw new Error(`Step ${step.id} has a ${target.sport} target in a ${sport} workout.`);
  }
  if (target?.source === "profile_derived" && target.resolved === undefined) {
    throw new Error(`Step ${step.id} needs a profile baseline before FIT export.`);
  }
  if (sport === "swimming") {
    const stroke = strokeFromNotes(step.notes);
    if (stroke !== undefined) {
      const pace = target?.resolved?.kind === "swimming_pace" ? target.resolved.paceSecPer100m : undefined;
      if (pace !== undefined) warnings.push(`Step ${step.id}: swim pace is a written cue; FIT enforces the stroke target only.`);
      return { targetType: 11, targetValue: ({ freestyle: 0, backstroke: 1, breaststroke: 2, butterfly: 3, drill: 4, mixed: 5 } as Record<string, number>)[stroke]!,
        notes: [step.notes, pace === undefined ? undefined : `${Math.round(pace)} sec/100m`].filter(Boolean).join("; ") };
    }
  }
  const resolved = target?.resolved;
  if (resolved?.kind === "running_pace" && resolved.paceBoundary !== undefined) {
    // A one-sided zone is not an exact pace or an invented finite speed range.
    warnings.push(`Step ${step.id}: open-ended running pace is a written cue only.`);
    return { targetType: 2, notes: [step.notes, `Running pace ${runningPaceLabel(resolved)}`].filter(Boolean).join("; ") };
  }
  if (resolved?.kind === "running_pace" || resolved?.kind === "swimming_pace") {
    const divisor = resolved.kind === "running_pace" ? 1000 : 100;
    const range = resolved.kind === "running_pace" ? resolved.rangePaceSecPerKm : resolved.rangePaceSecPer100m;
    const pace = resolved.kind === "running_pace" ? resolved.paceSecPerKm : resolved.paceSecPer100m;
    const slow = range?.[1] ?? pace;
    const fast = range?.[0] ?? pace;
    return { targetType: 0, targetValue: 0, customTargetValueLow: Math.round(1000 * divisor / slow), customTargetValueHigh: Math.round(1000 * divisor / fast), ...(step.notes === undefined ? {} : { notes: step.notes }) };
  }
  if (resolved?.kind === "cycling_power") {
    const range = resolved.rangeWatts ?? [resolved.watts, resolved.watts];
    // FIT stores absolute watt targets with a +1000 offset.
    return { targetType: 4, targetValue: 0, customTargetValueLow: 1000 + Math.round(range[0]), customTargetValueHigh: 1000 + Math.round(range[1]), ...(step.notes === undefined ? {} : { notes: step.notes }) };
  }
  return { targetType: 2, ...(step.notes === undefined ? {} : { notes: step.notes }) };
}

export function compileFitSteps(workout: Workout): { steps: WorkoutStepMesg[]; warnings: string[] } {
  const warnings: string[] = [];
  const steps: WorkoutStepMesg[] = [];
  function visit(group: WorkoutStep[]): void {
    for (const step of group) {
      if (step.type === "repeat") {
        const firstIndex = steps.length;
        visit(step.steps);
        steps.push({ messageIndex: steps.length, durationType: 6, durationValue: firstIndex, targetType: 2, targetValue: step.repetitions });
      } else {
        steps.push({ messageIndex: steps.length, wktStepName: step.type, intensity: intensity(step.type), ...durationFields(step), ...targetFields(step, workout.sport, warnings) });
      }
    }
  }
  visit(workout.steps);
  if (steps.length > 65535) throw new Error("FIT workout exceeds the step index limit.");
  return { steps, warnings };
}

export function exportFitWorkout(workout: Workout): FitExport {
  const validated = workoutSchema.parse(workout);
  const { steps, warnings } = compileFitSteps(validated);
  const encoder = new Encoder();
  const fileId: FileIdMesg = {
    type: 5, manufacturer: 255, product: 1, serialNumber: serialNumber(validated.id), timeCreated: new Date(validated.createdAt),
  };
  const summary: WorkoutMesg = {
    sport: { running: 1, cycling: 2, swimming: 5 }[validated.sport],
    ...(validated.sport === "swimming" ? { subSport: 17 } : {}),
    numValidSteps: steps.length,
    wktName: validated.name,
  };
  encoder.onMesg(Profile.MesgNum.FILE_ID!, fileId);
  encoder.onMesg(Profile.MesgNum.WORKOUT!, summary);
  for (const step of steps) encoder.onMesg(Profile.MesgNum.WORKOUT_STEP!, step);
  const bytes = encoder.close();
  const decoder = new Decoder(Stream.fromByteArray(bytes));
  if (!decoder.checkIntegrity()) throw new Error("FIT export failed its integrity check.");
  const decoded = decoder.read();
  if (decoded.errors.length > 0 || decoded.messages.workoutStepMesgs?.length !== steps.length) {
    throw new Error("FIT export failed its round-trip step check.");
  }
  return { bytes, warnings };
}
