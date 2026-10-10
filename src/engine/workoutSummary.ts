import type { Sport, WorkoutStep } from "../domain/index.js";

export type WorkoutSummary = {
  knownTimeSeconds: number;
  knownDistanceMetres: number;
  timeComplete: boolean;
  distanceComplete: boolean;
  timeEstimated: boolean;
  distanceEstimated: boolean;
  recoverySeconds: number;
  recoveryComplete: boolean;
};

function paceSecondsPerMetre(step: Exclude<WorkoutStep, { type: "repeat" }>, sport: Sport): number | undefined {
  const resolved = step.target?.resolved;
  // An open-ended zone only supplies a boundary, not an estimated running pace.
  if (sport === "running" && resolved?.kind === "running_pace") return resolved.paceBoundary === undefined ? resolved.paceSecPerKm / 1000 : undefined;
  if (sport === "swimming" && resolved?.kind === "swimming_pace") return resolved.paceSecPer100m / 100;
  return undefined;
}

/** Planned totals: distance/time conversion uses resolved pace, never watts or an invented speed. */
export function summarizeWorkout(steps: WorkoutStep[], sport: Sport): WorkoutSummary {
  const summary: WorkoutSummary = {
    knownTimeSeconds: 0,
    knownDistanceMetres: 0,
    timeComplete: true,
    distanceComplete: true,
    timeEstimated: false,
    distanceEstimated: false,
    recoverySeconds: 0,
    recoveryComplete: true,
  };

  function visit(nestedSteps: WorkoutStep[], multiplier: number): void {
    for (const step of nestedSteps) {
      if (step.type === "repeat") {
        visit(step.steps, multiplier * step.repetitions);
        continue;
      }
      const isRecovery = step.type === "rest" || step.type === "recovery";
      const pace = paceSecondsPerMetre(step, sport);
      if (step.duration.kind === "time") {
        summary.knownTimeSeconds += multiplier * step.duration.seconds;
        if (isRecovery) summary.recoverySeconds += multiplier * step.duration.seconds;
        if (step.type !== "rest") {
          if (pace === undefined) summary.distanceComplete = false;
          else {
            summary.knownDistanceMetres += multiplier * step.duration.seconds / pace;
            summary.distanceEstimated = true;
          }
        }
      } else if (step.duration.kind === "distance") {
        summary.knownDistanceMetres += multiplier * step.duration.metres;
        if (pace === undefined) summary.timeComplete = false;
        else {
          summary.knownTimeSeconds += multiplier * step.duration.metres * pace;
          summary.timeEstimated = true;
        }
        if (isRecovery) summary.recoveryComplete = false;
      } else {
        summary.timeComplete = false;
        if (step.type !== "rest") summary.distanceComplete = false;
        if (isRecovery) summary.recoveryComplete = false;
      }
    }
  }

  visit(steps, 1);
  return summary;
}
