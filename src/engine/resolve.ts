import type {
  AthleteProfile,
  ResolutionWarning,
  Target,
  Workout,
  WorkoutStep,
} from "../domain/index.js";
import { resolveCyclingTarget } from "./cycling.js";
import { resolveRunningTarget } from "./running.js";
import { resolveSwimmingTarget } from "./swimming.js";

// Resolution fills derived numeric values when a baseline exists and reports missing inputs otherwise.

export type ResolutionResult = {
  workout: Workout;
  warnings: ResolutionWarning[];
};

function warningFor(target: Target, stepId: string): ResolutionWarning | undefined {
  if (target.sport === "running" && target.source === "profile_derived") {
    return { code: "RUNNING_THRESHOLD_PACE_REQUIRED", stepId, message: "Running threshold pace is required." };
  }
  if (target.sport === "cycling" && target.source === "profile_derived") {
    return { code: "CYCLING_FTP_REQUIRED", stepId, message: "Cycling FTP is required." };
  }
  if (target.sport === "swimming" && target.source === "profile_derived") {
    return { code: "SWIMMING_THRESHOLD_PACE_REQUIRED", stepId, message: "Swimming threshold pace is required." };
  }
  return undefined;
}

function resolveTarget(
  target: Target,
  profile: AthleteProfile,
  stepId: string,
): { target: Target; warning?: ResolutionWarning | undefined } {
  if (target.source === "explicit") return { target };
  if (target.sport === "running") {
    const baseline = profile.running.thresholdPaceSecPerKm?.value;
    return baseline === undefined
      ? { target, warning: warningFor(target, stepId) }
      : { target: resolveRunningTarget(target, baseline) };
  }
  if (target.sport === "cycling") {
    const baseline = profile.cycling.ftpWatts?.value;
    return baseline === undefined
      ? { target, warning: warningFor(target, stepId) }
      : { target: resolveCyclingTarget(target, baseline) };
  }
  const baseline = profile.swimming.thresholdPaceSecPer100m?.value;
  return baseline === undefined
    ? { target, warning: warningFor(target, stepId) }
    : { target: resolveSwimmingTarget(target, baseline) };
}

function resolveSteps(steps: WorkoutStep[], profile: AthleteProfile, warnings: ResolutionWarning[]): WorkoutStep[] {
  // Repeats are traversed recursively so nested intervals behave like top-level steps.
  return steps.map((step) => {
    if (step.type === "repeat") {
      return { ...step, steps: resolveSteps(step.steps, profile, warnings) };
    }
    if (step.target === undefined) return step;
    const result = resolveTarget(step.target, profile, step.id);
    if (result.warning !== undefined) warnings.push(result.warning);
    return { ...step, target: result.target };
  });
}

export function resolveWorkoutTargets(workout: Workout, profile: AthleteProfile): ResolutionResult {
  const warnings: ResolutionWarning[] = [];
  const steps = resolveSteps(workout.steps, profile, warnings);
  return {
    workout: { ...workout, steps, profileSnapshot: profile, resolutionWarnings: warnings },
    warnings,
  };
}
