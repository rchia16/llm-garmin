import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { SqliteWorkoutRepository } from "../src/storage/index.js";
import { completeProfile } from "./fixtures/profiles.js";
import { runningThresholdWorkout } from "./fixtures/workouts.js";

// Persistence tests use disposable databases so local application data is never touched.

describe("SQLite persistence", () => {
  it("round-trips the profile and nested workout", () => {
    const directory = mkdtempSync(join(tmpdir(), "local-workout-builder-"));
    const repository = new SqliteWorkoutRepository(join(directory, "workout.db"));
    repository.saveProfile(completeProfile);
    repository.saveWorkout(runningThresholdWorkout);
    expect(repository.loadProfile()).toEqual(completeProfile);
    expect(repository.loadWorkout(runningThresholdWorkout.id)).toEqual(runningThresholdWorkout);
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("validates canonical JSON when loading", () => {
    const directory = mkdtempSync(join(tmpdir(), "local-workout-builder-invalid-"));
    const databasePath = join(directory, "workout.db");
    const repository = new SqliteWorkoutRepository(databasePath);
    repository.saveWorkout(runningThresholdWorkout);
    repository.close();

    const database = new Database(databasePath);
    database.prepare("UPDATE workouts SET canonical_json = ? WHERE id = ?").run("{}", runningThresholdWorkout.id);
    database.close();

    const reopened = new SqliteWorkoutRepository(databasePath);
    expect(() => reopened.loadWorkout(runningThresholdWorkout.id)).toThrow();
    reopened.close();
    rmSync(directory, { recursive: true, force: true });
  });
});
