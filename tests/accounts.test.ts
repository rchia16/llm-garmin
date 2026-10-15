import { describe, expect, it } from "vitest";
import { AccountStore } from "../src/shared/accounts.js";
import { runningExplicitWorkout } from "./fixtures/workouts.js";

const password = "temporary password 123";
const changed = "a different password 456";

describe("hosted account storage", () => {
  it("separates profiles/workouts and rejects stale revisions and foreign IDs", async () => {
    const store = new AccountStore(":memory:", () => Date.UTC(2026, 9, 15));
    try {
      const a = await store.createUser("alice", password), b = await store.createUser("bob", password);
      expect(store.profile(a.id).data.running.thresholdPaceSecPerKm).toBeUndefined();
      const profile = store.profile(a.id);
      store.saveProfile(a.id, { ...profile.data, cycling: { ...profile.data.cycling, ftpWatts: { value: 250, source: "manual", updatedAt: "2026-10-15T00:00:00Z" } } }, profile.revision);
      expect(store.profile(b.id).data.cycling.ftpWatts).toBeUndefined();
      expect(() => store.saveProfile(a.id, profile.data, profile.revision)).toThrow("REVISION_CONFLICT");
      const workout = store.saveWorkout(a.id, runningExplicitWorkout);
      expect(workout.data.id).not.toBe(runningExplicitWorkout.id);
      expect(store.workouts(b.id)).toEqual([]);
      expect(() => store.workout(b.id, workout.data.id)).toThrow("NOT_FOUND");
      expect(() => store.saveWorkout(b.id, runningExplicitWorkout, 1, workout.data.id)).toThrow("NOT_FOUND");
      expect(store.saveWorkout(a.id, runningExplicitWorkout, 1, workout.data.id).revision).toBe(2);
      expect(() => store.saveWorkout(a.id, runningExplicitWorkout, 1, workout.data.id)).toThrow("REVISION_CONFLICT");
    } finally { store.close(); }
  }, 30000);

  it("requires temporary-password changes and revokes sessions on changes, resets and disabling", async () => {
    const store = new AccountStore(":memory:", () => Date.UTC(2026, 9, 15));
    try {
      const user = await store.createUser("alice", password);
      const first = (await store.login("alice", password))!;
      expect(first.session.user.mustChangePassword).toBe(true);
      expect(await store.login("alice", "incorrect")).toBeUndefined();
      expect(await store.login("unknown", password)).toBeUndefined();
      await expect(store.changePassword(user.id, "incorrect", changed)).rejects.toThrow("PASSWORD_INCORRECT");
      await store.changePassword(user.id, password, changed);
      expect(store.session(first.token)).toBeUndefined();
      const second = (await store.login("alice", changed))!;
      expect(second.session.user.mustChangePassword).toBe(false);
      await store.resetPassword("alice", password);
      expect(store.session(second.token)).toBeUndefined();
      const third = (await store.login("alice", password))!;
      expect(third.session.user.mustChangePassword).toBe(true);
      store.disable("alice");
      expect(store.session(third.token)).toBeUndefined();
      expect(await store.login("alice", password)).toBeUndefined();
    } finally { store.close(); }
  }, 30000);

  it("enforces idle and absolute expiry using an injected clock", async () => {
    let now = Date.UTC(2026, 9, 15);
    const day = 86400000;
    const store = new AccountStore(":memory:", () => now);
    try {
      await store.createUser("alice", password);
      const idle = (await store.login("alice", password))!;
      now += day;
      expect(store.session(idle.token)).toBeUndefined();
      const absolute = (await store.login("alice", password))!;
      for (let index = 0; index < 13; index++) { now += day / 2; expect(store.session(absolute.token)).toBeDefined(); }
      now += day / 2;
      expect(store.session(absolute.token)).toBeUndefined();
    } finally { store.close(); }
  }, 30000);
});
