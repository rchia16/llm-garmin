import type { AthleteProfile, Target, Workout, WorkoutStep } from "../domain/index.js";
import { resolveCyclingTarget } from "./cycling.js";
import { resolveRunningTarget } from "./running.js";
import { resolveSwimmingTarget } from "./swimming.js";
import { resolveWorkoutTargets } from "./resolve.js";

// Recalculation defaults to relative targets only; explicit rescaling is an intentional opt-in.

export type RecalculationMode = "relativeTargetsOnly" | "allCompatibleTargets";

function rescaleExplicitTarget(target: Target, previous: AthleteProfile, current: AthleteProfile): Target {
  if (target.source !== "explicit") return target;
  if (target.sport === "running") {
    const previousBaseline = previous.running.thresholdPaceSecPerKm?.value;
    const currentBaseline = current.running.thresholdPaceSecPerKm?.value;
    if (previousBaseline === undefined || currentBaseline === undefined) return target;
    const paceSecPerKm = target.paceSecPerKm * currentBaseline / previousBaseline;
    return { ...target, paceSecPerKm, resolved: { kind: "running_pace", paceSecPerKm } };
  }
  if (target.sport === "cycling") {
    const previousBaseline = previous.cycling.ftpWatts?.value;
    const currentBaseline = current.cycling.ftpWatts?.value;
    if (previousBaseline === undefined || currentBaseline === undefined) return target;
    const watts = target.watts * currentBaseline / previousBaseline;
    return { ...target, watts, resolved: { kind: "cycling_power", watts } };
  }
  const previousBaseline = previous.swimming.thresholdPaceSecPer100m?.value;
  const currentBaseline = current.swimming.thresholdPaceSecPer100m?.value;
  if (previousBaseline === undefined || currentBaseline === undefined) return target;
  const paceSecPer100m = target.paceSecPer100m + currentBaseline - previousBaseline;
  return { ...target, paceSecPer100m, resolved: { kind: "swimming_pace", paceSecPer100m } };
}

function rescaleExplicitSteps(steps: WorkoutStep[], previous: AthleteProfile, current: AthleteProfile): WorkoutStep[] {
  return steps.map((step) => step.type === "repeat"
    ? { ...step, steps: rescaleExplicitSteps(step.steps, previous, current) }
    : step.target === undefined
      ? step
      : { ...step, target: rescaleExplicitTarget(step.target, previous, current) });
}

export function recalculateWorkout(
  workout: Workout,
  profile: AthleteProfile,
  mode: RecalculationMode = "relativeTargetsOnly",
  previousProfile?: AthleteProfile,
): Workout {
  const recalculated = resolveWorkoutTargets(workout, profile).workout;
  if (mode !== "allCompatibleTargets" || previousProfile === undefined) return recalculated;
  return resolveWorkoutTargets(
    { ...recalculated, steps: rescaleExplicitSteps(recalculated.steps, previousProfile, profile) },
    profile,
  ).workout;
}
