import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { AccountStore } from "../src/shared/accounts.js";
import { runningExplicitWorkout } from "./fixtures/workouts.js";

it("reloads validated user data and sessions across restarts and rejects future migrations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workout-account-db-"));
  const path = join(directory, "accounts.sqlite");
  const now = () => Date.UTC(2026, 9, 15);
  let store = new AccountStore(path, now);
  try {
    const user = await store.createUser("alice", "temporary fixture password");
    const login = (await store.login("alice", "temporary fixture password"))!;
    const workout = store.saveWorkout(user.id, runningExplicitWorkout);
    store.close();
    store = new AccountStore(path, now);
    expect(store.session(login.token)?.user.id).toBe(user.id);
    expect(store.workout(user.id, workout.data.id)).toEqual(workout);
    expect(store.profile(user.id).data.id).toBe(user.id);
  } finally { store.close(); }
  try {
    const future = new Database(path);
    future.pragma("user_version = 2"); future.close();
    expect(() => new AccountStore(path, now)).toThrow("newer than this application");
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30000);
