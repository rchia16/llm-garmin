import { resolve } from "node:path";
import {
  recalculateWorkout,
  resolveWorkoutTargets,
  secondsPerKmToPaceString,
  updateRunningThreshold,
} from "./engine/index.js";
import { demoProfile, demoRunningExplicitWorkout, demoRunningThresholdWorkout } from "./fixtures.js";
import { SqliteWorkoutRepository } from "./storage/index.js";

// This CLI intentionally exercises the same resolution, recalculation, and persistence APIs as callers.

const initialProfile = updateRunningThreshold(demoProfile, 265, {
  source: "manual",
  updatedAt: "2026-01-01T08:00:00.000Z",
});
const resolved = resolveWorkoutTargets(demoRunningThresholdWorkout, initialProfile).workout;
const resolvedRepeat = resolved.steps[0];
const derivedTarget = resolvedRepeat?.type === "repeat" ? resolvedRepeat.steps[0]?.type !== "repeat" ? resolvedRepeat.steps[0]?.target : undefined : undefined;
if (derivedTarget?.resolved?.kind !== "running_pace") throw new Error("Expected a resolved running target.");

console.log(`Running threshold: ${secondsPerKmToPaceString(initialProfile.running.thresholdPaceSecPerKm?.value ?? 0)}`);
console.log(`Workout: ${resolved.name}`);
console.log(`Work target: ${secondsPerKmToPaceString(derivedTarget.resolved.paceSecPerKm)}`);

const updatedProfile = updateRunningThreshold(initialProfile, 258, {
  source: "manual",
  updatedAt: "2026-01-02T08:00:00.000Z",
});
const recalculated = recalculateWorkout(resolved, updatedProfile);
const recalculatedRepeat = recalculated.steps[0];
const recalculatedTarget = recalculatedRepeat?.type === "repeat" ? recalculatedRepeat.steps[0]?.type !== "repeat" ? recalculatedRepeat.steps[0]?.target : undefined : undefined;
if (recalculatedTarget?.resolved?.kind !== "running_pace") throw new Error("Expected recalculated target.");

console.log(`Updating threshold -> ${secondsPerKmToPaceString(258)}`);
console.log(`Derived threshold target: ${secondsPerKmToPaceString(derivedTarget.resolved.paceSecPerKm)} -> ${secondsPerKmToPaceString(recalculatedTarget.resolved.paceSecPerKm)}`);

const explicitBeforeStep = demoRunningExplicitWorkout.steps[0];
const explicitAfterStep = recalculateWorkout(demoRunningExplicitWorkout, updatedProfile).steps[0];
const explicitBefore = explicitBeforeStep?.type !== "repeat" ? explicitBeforeStep?.target : undefined;
const explicitAfter = explicitAfterStep?.type !== "repeat" ? explicitAfterStep?.target : undefined;
if (explicitBefore?.resolved?.kind !== "running_pace" || explicitAfter?.resolved?.kind !== "running_pace") throw new Error("Expected explicit target.");
console.log(`Explicit 4:30/km target: ${secondsPerKmToPaceString(explicitBefore.resolved.paceSecPerKm)} -> ${secondsPerKmToPaceString(explicitAfter.resolved.paceSecPerKm)}`);

const repository = new SqliteWorkoutRepository(resolve(process.cwd(), "data", "workout.db"));
repository.saveProfile(updatedProfile);
repository.saveWorkout(recalculated);
const loaded = repository.loadWorkout(recalculated.id);
repository.close();
if (loaded === undefined) throw new Error("Workout was not reloaded.");
console.log(`Saved workout: ${loaded.id}`);
console.log("Reloaded successfully.");
