import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  athleteProfileSchema,
  workoutSchema,
  type AthleteProfile,
  type Workout,
} from "../domain/index.js";

// SQLite stores indexed metadata alongside validated canonical JSON rather than normalizing workout steps.

export interface WorkoutRepository {
  saveProfile(profile: AthleteProfile): void;
  loadProfile(): AthleteProfile | undefined;
  saveWorkout(workout: Workout): void;
  loadWorkout(id: string): Workout | undefined;
  close(): void;
}

export class SqliteWorkoutRepository implements WorkoutRepository {
  private readonly database: Database.Database;

  public constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new Database(databasePath);
    this.database.pragma("foreign_keys = ON");
    // CREATE IF NOT EXISTS makes startup safe for both a new database and an existing local database.
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS athlete_profile (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        profile_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workouts (
        id TEXT PRIMARY KEY,
        sport TEXT NOT NULL,
        name TEXT NOT NULL,
        scheduled_date TEXT,
        canonical_json TEXT NOT NULL,
        source_prompt TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  public saveProfile(profile: AthleteProfile): void {
    const validated = athleteProfileSchema.parse(profile);
    this.database.prepare(`
      INSERT INTO athlete_profile (singleton_id, profile_json, updated_at)
      VALUES (1, ?, ?)
      ON CONFLICT(singleton_id) DO UPDATE SET profile_json = excluded.profile_json, updated_at = excluded.updated_at
    `).run(JSON.stringify(validated), new Date().toISOString());
  }

  public loadProfile(): AthleteProfile | undefined {
    const row = this.database.prepare("SELECT profile_json FROM athlete_profile WHERE singleton_id = 1").get() as { profile_json: string } | undefined;
    // Parsing on read protects the engine from manually edited or stale database contents.
    return row === undefined ? undefined : athleteProfileSchema.parse(JSON.parse(row.profile_json) as unknown);
  }

  public saveWorkout(workout: Workout): void {
    const validated = workoutSchema.parse(workout);
    this.database.prepare(`
      INSERT INTO workouts (id, sport, name, scheduled_date, canonical_json, source_prompt, created_at, updated_at)
      VALUES (@id, @sport, @name, @scheduledDate, @canonicalJson, @sourcePrompt, @createdAt, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET
        sport = excluded.sport,
        name = excluded.name,
        scheduled_date = excluded.scheduled_date,
        canonical_json = excluded.canonical_json,
        source_prompt = excluded.source_prompt,
        updated_at = excluded.updated_at
    `).run({
      id: validated.id,
      sport: validated.sport,
      name: validated.name,
      scheduledDate: validated.scheduledDate ?? null,
      canonicalJson: JSON.stringify(validated),
      sourcePrompt: validated.sourcePrompt ?? null,
      createdAt: validated.createdAt,
      updatedAt: validated.updatedAt,
    });
  }

  public loadWorkout(id: string): Workout | undefined {
    const row = this.database.prepare("SELECT canonical_json FROM workouts WHERE id = ?").get(id) as { canonical_json: string } | undefined;
    return row === undefined ? undefined : workoutSchema.parse(JSON.parse(row.canonical_json) as unknown);
  }

  public close(): void {
    this.database.close();
  }
}
