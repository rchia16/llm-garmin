import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { athleteProfileSchema, workoutSchema } from "../domain/index.js";
import { AccountError, AccountStore, passwordSchema, type Session } from "./accounts.js";
import { UserGarmin } from "./garmin.js";
import { InferenceQueue } from "./inferenceQueue.js";

const COOKIE = "__Host-workout-session";
const revisionSchema = z.number().int().positive();
const loginSchema = z.object({ username: z.string().trim().min(1).max(80), password: z.string().min(1).max(1024) }).strict();
const changeSchema = z.object({ currentPassword: z.string().min(1).max(1024), password: passwordSchema }).strict();
const actions = new Set(["status", "send", "login", "mfa", "cancel", "logout"] as const);

export async function requestBody(request: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) throw new AccountError(400, "INVALID_REQUEST");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > 1_048_576) throw new AccountError(413, "BODY_TOO_LARGE");
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
  catch { throw new AccountError(400, "INVALID_REQUEST"); }
}

export function apiReply(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

export class HostedApi {
  readonly queue: InferenceQueue;
  private activeLogins = 0;
  private globalAttempts = { count: 0, until: 0 };
  private readonly attempts = new Map<string, { count: number; until: number }>();
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly unsubscribe: () => void;
  constructor(readonly store: AccountStore, readonly garmin: UserGarmin, private readonly origin: string,
    private readonly now: () => number = Date.now) {
    this.queue = new InferenceQueue(id => !!store.sessionById(id));
    this.unsubscribe = store.onRevoke(id => { this.garmin.cancelSession(id); this.queue.cancelSession(id); });
    this.timer = setInterval(() => {
      store.pruneSessions();
      this.garmin.sweep(id => !!store.sessionById(id));
      this.queue.sweep();
    }, 10_000);
    this.timer.unref();
  }
  authenticate(request: IncomingMessage, mutation = false, touch = true): Session {
    const cookie = request.headers.cookie?.split(";").map(part => part.trim()).find(part => part.startsWith(COOKIE + "="))?.slice(COOKIE.length + 1) ?? "";
    const session = this.store.session(cookie, touch);
    if (!session) throw new AccountError(401, "AUTH_REQUIRED");
    if (mutation && (request.headers.origin !== this.origin || request.headers["x-csrf-token"] !== session.csrfToken)) throw new AccountError(403, "FORBIDDEN");
    return session;
  }
  private limitLogin(username: string): void {
    const now = this.now();
    if (this.globalAttempts.until <= now) this.globalAttempts = { count: 0, until: now + 60_000 };
    if (this.activeLogins >= 2 || this.globalAttempts.count >= 20) throw new AccountError(429, "LOGIN_RATE_LIMITED");
    for (const [key, value] of this.attempts) if (value.until <= now) this.attempts.delete(key);
    let attempt = this.attempts.get(username);
    if (!attempt) { attempt = { count: 0, until: now + 15 * 60_000 }; this.attempts.set(username, attempt); }
    if (attempt.count >= 5) throw new AccountError(429, "LOGIN_RATE_LIMITED");
    attempt.count++; this.globalAttempts.count++;
  }
  async handle(request: IncomingMessage, response: ServerResponse, path: string): Promise<boolean> {
    if (!path.startsWith("/api/auth/") && path !== "/api/profile" && !path.startsWith("/api/workouts") && !path.startsWith("/api/garmin/")) return false;
    try {
      if (path === "/api/auth/login" && request.method === "POST") {
        if (request.headers.origin !== this.origin) throw new AccountError(403, "FORBIDDEN");
        const data = loginSchema.parse(await requestBody(request));
        this.limitLogin(data.username.toLowerCase());
        this.activeLogins++;
        try {
          const login = await this.store.login(data.username, data.password);
          if (!login) throw new AccountError(401, "INVALID_CREDENTIALS");
          response.setHeader("Set-Cookie", `${COOKIE}=${login.token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=604800`);
          apiReply(response, 200, { user: login.session.user, csrfToken: login.session.csrfToken });
        } finally { this.activeLogins--; }
        return true;
      }
      const session = this.authenticate(request, request.method !== "GET", path !== "/api/auth/session");
      response.setHeader("X-Workout-User", session.user.id);
      if (path === "/api/auth/session" && request.method === "GET") {
        apiReply(response, 200, { user: session.user, csrfToken: session.csrfToken }); return true;
      }
      if (path === "/api/auth/logout" && request.method === "POST") {
        this.store.revoke(session.id);
        response.setHeader("Set-Cookie", `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`);
        apiReply(response, 200, { ok: true }); return true;
      }
      if (path === "/api/auth/password" && request.method === "POST") {
        const data = changeSchema.parse(await requestBody(request));
        if (this.activeLogins >= 2) throw new AccountError(429, "LOGIN_RATE_LIMITED");
        this.limitLogin(session.user.username);
        this.activeLogins++;
        try { await this.store.changePassword(session.user.id, data.currentPassword, data.password); }
        finally { this.activeLogins--; }
        response.setHeader("Set-Cookie", `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`);
        apiReply(response, 200, { ok: true }); return true;
      }
      if (session.user.mustChangePassword) throw new AccountError(403, "PASSWORD_CHANGE_REQUIRED");
      if (path === "/api/profile") {
        if (request.method === "GET") apiReply(response, 200, this.store.profile(session.user.id));
        else if (request.method === "PUT") {
          const data = z.object({ revision: revisionSchema, data: athleteProfileSchema }).strict().parse(await requestBody(request));
          this.assertSession(session);
          apiReply(response, 200, this.store.saveProfile(session.user.id, data.data, data.revision));
        } else throw new AccountError(405, "METHOD_NOT_ALLOWED");
        return true;
      }
      if (path === "/api/workouts") {
        if (request.method === "GET") apiReply(response, 200, this.store.workouts(session.user.id));
        else if (request.method === "POST") {
          const data = workoutSchema.parse(await requestBody(request));
          this.assertSession(session);
          apiReply(response, 201, this.store.saveWorkout(session.user.id, data));
        } else throw new AccountError(405, "METHOD_NOT_ALLOWED");
        return true;
      }
      const workout = /^\/api\/workouts\/([a-f0-9-]{36})$/.exec(path);
      if (workout) {
        if (request.method === "GET") apiReply(response, 200, this.store.workout(session.user.id, workout[1]!));
        else if (request.method === "PUT") {
          const data = z.object({ revision: revisionSchema, data: workoutSchema }).strict().parse(await requestBody(request));
          this.assertSession(session);
          apiReply(response, 200, this.store.saveWorkout(session.user.id, data.data, data.revision, workout[1]!));
        } else throw new AccountError(405, "METHOD_NOT_ALLOWED");
        return true;
      }
      const action = path.slice("/api/garmin/".length) as "status" | "send" | "login" | "mfa" | "cancel" | "logout";
      if (path.startsWith("/api/garmin/") && actions.has(action) && request.method === "POST") {
        const input = ["send", "login", "mfa"].includes(action) ? await requestBody(request) : undefined;
        this.assertSession(session);
        const result = await this.garmin.execute(session, action, input);
        this.assertSession(session);
        apiReply(response, 200, result); return true;
      }
      throw new AccountError(404, "NOT_FOUND");
    } catch (error) { this.error(response, error); return true; }
  }
  assertSession(session: Session): void {
    if (!this.store.sessionById(session.id)) throw new AccountError(401, "AUTH_REQUIRED");
  }
  error(response: ServerResponse, error: unknown): void {
    if (response.destroyed || response.writableEnded) return;
    const status = error instanceof AccountError ? error.status : error instanceof z.ZodError ? 400 : 500;
    if (status === 429) response.setHeader("Retry-After", "60");
    apiReply(response, status, { error: error instanceof AccountError ? error.message : status === 400 ? "INVALID_REQUEST" : "SERVER_ERROR" });
  }
  close(): void { clearInterval(this.timer); this.unsubscribe(); this.queue.close(); this.garmin.close(); }
}
