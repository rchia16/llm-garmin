import Database from "better-sqlite3";
import { randomBytes, randomUUID, scrypt, timingSafeEqual, createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { athleteProfileSchema, workoutSchema, type AthleteProfile, type Workout } from "../domain/index.js";

export const passwordSchema = z.string().min(12).max(1024);
export const usernameSchema = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9_.@+-]{2,79}$/);
const IDLE_MS = 24 * 60 * 60 * 1000;
const LIFETIME_MS = 7 * IDLE_MS;
const hash = (text: string): string => createHash("sha256").update(text).digest("hex");

async function passwordHash(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, 64,
    { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 },
    (error, result) => error ? reject(error) : resolve(result)));
}

export type Account = { id: string; username: string; mustChangePassword: boolean };
type UserRow = { id: string; username: string; password_hash: string; salt: string; disabled: number; must_change: number };
export type Session = { id: string; user: Account; csrfToken: string };
type SessionRow = UserRow & { token_hash: string; csrf: string; last_seen: number; expires: number };
export type Versioned<T> = { revision: number; data: T };
export class AccountError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

export function emptyProfile(userId: string): AthleteProfile {
  return athleteProfileSchema.parse({ id: userId,
    running: { paceZoneSystem: "friel_trainingpeaks" },
    cycling: { powerZoneSystem: "coggan" },
    swimming: { thresholdMethod: "css", paceZoneSystem: "joe_friel_trainingpeaks" },
  });
}

/** Hosted ownership lives outside the platform-independent canonical models. */
export class AccountStore {
  private readonly db: Database.Database;
  private readonly revokeListeners = new Set<(sessionId: string) => void>();
  constructor(path: string, private readonly now: () => number = Date.now) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path);
    if (path !== ":memory:" && process.platform !== "win32") chmodSync(path, 0o600);
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("journal_mode = WAL");
    const version = this.db.pragma("user_version", { simple: true }) as number;
    if (version > 1) { this.db.close(); throw new Error("Hosted database version is newer than this application."); }
    if (version === 0) this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL, salt TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0,
          must_change INTEGER NOT NULL DEFAULT 1);
        CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
          csrf TEXT NOT NULL, last_seen INTEGER NOT NULL, expires INTEGER NOT NULL);
        CREATE INDEX sessions_user ON sessions(user_id);
        CREATE TABLE profiles (user_id TEXT PRIMARY KEY REFERENCES users(id), revision INTEGER NOT NULL, json TEXT NOT NULL);
        CREATE TABLE saved_workouts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
          revision INTEGER NOT NULL, json TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE INDEX workouts_owner ON saved_workouts(user_id, updated_at);
        PRAGMA user_version = 1;
      `);
    })();
  }

  onRevoke(listener: (sessionId: string) => void): () => void {
    this.revokeListeners.add(listener);
    return () => this.revokeListeners.delete(listener);
  }
  private account(row: UserRow): Account {
    return { id: row.id, username: row.username, mustChangePassword: row.must_change === 1 };
  }
  async createUser(username: string, password: string): Promise<Account> {
    username = usernameSchema.parse(username);
    passwordSchema.parse(password);
    const salt = randomBytes(16).toString("hex");
    const digest = (await passwordHash(password, salt)).toString("hex");
    const id = randomUUID();
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO users(id,username,password_hash,salt) VALUES(?,?,?,?)").run(id, username, digest, salt);
      this.db.prepare("INSERT INTO profiles VALUES(?,1,?)").run(id, JSON.stringify(emptyProfile(id)));
    })();
    return { id, username, mustChangePassword: true };
  }
  async login(username: string, password: string): Promise<{ token: string; session: Session } | undefined> {
    const row = this.db.prepare("SELECT * FROM users WHERE username = ?").get(username.trim().toLowerCase()) as UserRow | undefined;
    // Unknown accounts perform the same expensive calculation to avoid a cheap existence probe.
    const digest = await passwordHash(password, row?.salt ?? "00000000000000000000000000000000");
    if (!row || row.disabled || !timingSafeEqual(digest, Buffer.from(row.password_hash, "hex"))) return undefined;
    // Recheck after asynchronous hashing in case an administrator reset or disabled the account.
    const current = this.db.prepare("SELECT * FROM users WHERE id = ?").get(row.id) as UserRow;
    if (current.disabled || current.password_hash !== row.password_hash) return undefined;
    this.pruneSessions();
    const token = randomBytes(32).toString("hex");
    const id = hash(token), csrfToken = randomBytes(32).toString("hex"), now = this.now();
    this.db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?)").run(id, row.id, csrfToken, now, now + LIFETIME_MS);
    return { token, session: { id, user: this.account(current), csrfToken } };
  }
  session(token: string, touch = true): Session | undefined {
    if (!/^[a-f0-9]{64}$/.test(token)) return undefined;
    return this.sessionById(hash(token), touch);
  }
  sessionById(id: string, touch = false): Session | undefined {
    const row = this.db.prepare(`SELECT users.*, sessions.* FROM sessions JOIN users ON users.id = sessions.user_id
      WHERE token_hash = ?`).get(id) as SessionRow | undefined;
    if (!row) return undefined;
    const now = this.now();
    if (row.disabled || row.expires <= now || row.last_seen + IDLE_MS <= now) { this.revoke(id); return undefined; }
    if (touch) this.db.prepare("UPDATE sessions SET last_seen = ? WHERE token_hash = ?").run(now, id);
    return { id, user: this.account(row), csrfToken: row.csrf };
  }
  pruneSessions(): void {
    const rows = this.db.prepare("SELECT token_hash FROM sessions WHERE expires <= ? OR last_seen <= ?")
      .all(this.now(), this.now() - IDLE_MS) as { token_hash: string }[];
    for (const row of rows) this.revoke(row.token_hash);
  }
  revoke(id: string): void {
    this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(id);
    for (const listener of this.revokeListeners) listener(id);
  }
  private revokeUser(id: string): void {
    const rows = this.db.prepare("SELECT token_hash FROM sessions WHERE user_id = ?").all(id) as { token_hash: string }[];
    for (const row of rows) this.revoke(row.token_hash);
  }
  async changePassword(id: string, currentPassword: string, nextPassword: string): Promise<void> {
    if (currentPassword === nextPassword) throw new AccountError(400, "PASSWORD_UNCHANGED");
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow;
    const digest = await passwordHash(currentPassword, row.salt);
    if (!timingSafeEqual(digest, Buffer.from(row.password_hash, "hex"))) throw new AccountError(400, "PASSWORD_INCORRECT");
    await this.setPassword(id, nextPassword, false, row.password_hash);
  }
  private async setPassword(id: string, password: string, temporary: boolean, previousHash?: string): Promise<void> {
    passwordSchema.parse(password);
    const salt = randomBytes(16).toString("hex");
    const digest = (await passwordHash(password, salt)).toString("hex");
    const changed = previousHash === undefined
      ? this.db.prepare("UPDATE users SET password_hash=?,salt=?,must_change=? WHERE id=?").run(digest, salt, temporary ? 1 : 0, id)
      : this.db.prepare("UPDATE users SET password_hash=?,salt=?,must_change=? WHERE id=? AND password_hash=? AND disabled=0")
        .run(digest, salt, temporary ? 1 : 0, id, previousHash);
    if (!changed.changes) throw new AccountError(401, "AUTH_REQUIRED");
    this.revokeUser(id);
  }
  async resetPassword(username: string, password: string): Promise<void> {
    await this.setPassword(this.userId(username), password, true);
  }
  disable(username: string): void {
    const id = this.userId(username);
    this.db.prepare("UPDATE users SET disabled=1 WHERE id=?").run(id);
    this.revokeUser(id);
  }
  private userId(username: string): string {
    const row = this.db.prepare("SELECT id FROM users WHERE username=?").get(usernameSchema.parse(username)) as { id: string } | undefined;
    if (!row) throw new AccountError(404, "USER_NOT_FOUND");
    return row.id;
  }
  profile(userId: string): Versioned<AthleteProfile> {
    const row = this.db.prepare("SELECT revision,json FROM profiles WHERE user_id=?").get(userId) as { revision: number; json: string };
    return { revision: row.revision, data: athleteProfileSchema.parse(JSON.parse(row.json)) };
  }
  saveProfile(userId: string, data: AthleteProfile, revision: number): Versioned<AthleteProfile> {
    const validated = athleteProfileSchema.parse({ ...data, id: userId });
    const result = this.db.prepare("UPDATE profiles SET json=?, revision=revision+1 WHERE user_id=? AND revision=?")
      .run(JSON.stringify(validated), userId, revision);
    if (!result.changes) throw new AccountError(409, "REVISION_CONFLICT");
    return { revision: revision + 1, data: validated };
  }
  workouts(userId: string): Versioned<Workout>[] {
    return (this.db.prepare("SELECT revision,json FROM saved_workouts WHERE user_id=? ORDER BY updated_at DESC").all(userId) as { revision: number; json: string }[])
      .map(row => ({ revision: row.revision, data: workoutSchema.parse(JSON.parse(row.json)) }));
  }
  workout(userId: string, id: string): Versioned<Workout> {
    const row = this.db.prepare("SELECT revision,json FROM saved_workouts WHERE user_id=? AND id=?").get(userId, id) as { revision: number; json: string } | undefined;
    if (!row) throw new AccountError(404, "NOT_FOUND");
    return { revision: row.revision, data: workoutSchema.parse(JSON.parse(row.json)) };
  }
  saveWorkout(userId: string, input: Workout, revision?: number, id?: string): Versioned<Workout> {
    if (id !== undefined) this.workout(userId, id);
    const data = workoutSchema.parse({ ...input, id: id ?? randomUUID(), updatedAt: new Date(this.now()).toISOString() });
    if (id === undefined) this.db.prepare("INSERT INTO saved_workouts VALUES(?,?,1,?,?)").run(data.id, userId, JSON.stringify(data), data.updatedAt);
    else if (!this.db.prepare("UPDATE saved_workouts SET json=?,updated_at=?,revision=revision+1 WHERE id=? AND user_id=? AND revision=?")
      .run(JSON.stringify(data), data.updatedAt, id, userId, revision).changes) throw new AccountError(409, "REVISION_CONFLICT");
    return { data, revision: id === undefined ? 1 : revision! + 1 };
  }
  close(): void { this.db.close(); }
}
