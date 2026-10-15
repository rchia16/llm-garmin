import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountStore, type Session } from "../src/shared/accounts.js";
import { HostedApi } from "../src/shared/hostedApi.js";
import { UserGarmin } from "../src/shared/garmin.js";
import { createSharedServer } from "../src/shared/server.js";
import { runningExplicitWorkout } from "./fixtures/workouts.js";
import { completeProfile } from "./fixtures/profiles.js";

const origin = "https://workouts.example:8443";
const password = "temporary password 123", changed = "different password 456";
type Client = { token: string; session: Session };
let directory: string, server: Server, address: string, store: AccountStore, hosted: HostedApi;
let alice: Client, bob: Client, temporary: Client;
const factory = vi.fn((directory: string) => ({
  run: vi.fn(async (command: string, _input?: unknown) => command === "logout" ? { ok: true as const, code: "LOGGED_OUT" as const } : command === "send" ? { ok: true as const, code: "SCHEDULED" as const, workoutId: 42, date: "2026-10-15" } : { ok: true as const, code: "READY" as const }),
  auth: vi.fn(async (action: string) => action === "login" ? { ok: false as const, code: "MFA_REQUIRED" as const } : action === "cancel" ? { ok: false as const, code: "CANCELLED" as const } : { ok: true as const, code: "READY" as const }),
}));

async function request(path: string, client?: Client, method = "GET", body?: unknown, extra: Record<string, string> = {}) {
  return await new Promise<{ status: number; data: unknown; headers: import("node:http").IncomingHttpHeaders }>((resolve, reject) => {
    const outgoing = httpRequest(address + path, { method, headers: { Host: "workouts.example:8443", Origin: origin, "Content-Type": "application/json",
      ...(client ? { Cookie: `__Host-workout-session=${client.token}`, "X-CSRF-Token": client.session.csrfToken } : {}), ...extra } }, incoming => {
      let data = ""; incoming.setEncoding("utf8"); incoming.on("data", chunk => { data += chunk; });
      incoming.on("end", () => resolve({ status: incoming.statusCode!, data: incoming.headers["content-type"]?.includes("json") ? JSON.parse(data) : data, headers: incoming.headers }));
    });
    outgoing.on("error", reject); outgoing.end(body === undefined || method === "GET" ? undefined : JSON.stringify(body));
  });
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "workout-accounts-"));
  await writeFile(join(directory, "index.html"), "<html>Workout Builder</html>");
  store = new AccountStore(join(directory, "accounts.sqlite"), () => Date.UTC(2026, 9, 15));
  for (const username of ["alice", "bob", "temporary"]) {
    const user = await store.createUser(username, password);
    if (username !== "temporary") await store.changePassword(user.id, password, changed);
  }
  alice = (await store.login("alice", changed))!; bob = (await store.login("bob", changed))!; temporary = (await store.login("temporary", password))!;
  hosted = new HostedApi(store, new UserGarmin(directory, factory), origin);
  server = createSharedServer({ publicOrigin: origin, staticDirectory: directory, hosted, fetch: vi.fn(async () => new Response('{"choices":[{"message":{"content":"{}"}}]}')) });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 30000);
afterAll(async () => {
  hosted?.close();
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  store?.close(); if (directory) await rm(directory, { recursive: true, force: true });
});

describe("authenticated hosted server", () => {
  it("authenticates inference and protects it with CSRF", async () => {
    const payload = { messages: [{ role: "user", content: "fixture workout" }], temperature: 0, max_tokens: 10,
      chat_template_kwargs: { enable_thinking: false },
      response_format: { type: "json_schema", json_schema: { name: "workout_interpretation", strict: true, schema: {} } } };
    expect((await request("/api/inference/v1/chat/completions", alice, "POST", payload, { "X-CSRF-Token": "invalid" })).status).toBe(403);
    const response = await request("/api/inference/v1/chat/completions", alice, "POST", payload);
    expect(response.status).toBe(200);
    expect(response.data).toMatchObject({ choices: [{ message: { content: "{}" } }] });
  });
  it("requires authentication and a password change before personal/inference APIs", async () => {
    expect((await request("/")).status).toBe(200);
    for (const path of ["/api/profile", "/api/workouts", "/api/garmin/status", "/api/inference/v1/chat/completions"]) {
      expect((await request(path, undefined, path.includes("profile") || path.includes("workouts") ? "GET" : "POST", {})).status).toBe(401);
    }
    expect((await request("/api/profile", temporary)).data).toEqual({ error: "PASSWORD_CHANGE_REQUIRED" });
    expect((await request("/api/auth/session", alice)).data).toMatchObject({ user: { username: "alice" } });
  });
  it("uses secure cookies and generic failures and bounds login attempts", async () => {
    const login = await request("/api/auth/login", undefined, "POST", { username: "alice", password: changed });
    expect(login.status).toBe(200);
    expect(login.headers["set-cookie"]?.[0]).toMatch(/Secure; HttpOnly; SameSite=Strict/);
    expect((await request("/api/auth/login", undefined, "POST", { username: "missing", password: "wrong" })).data).toEqual({ error: "INVALID_CREDENTIALS" });
    expect((await request("/api/auth/login", undefined, "POST", { username: "alice", password: "wrong" }, { Origin: "https://other.example" })).status).toBe(403);
    for (let index = 0; index < 5; index++) await request("/api/auth/login", undefined, "POST", { username: "limited", password: "wrong" });
    expect((await request("/api/auth/login", undefined, "POST", { username: "limited", password: "wrong" })).status).toBe(429);
  }, 30000);
  it("rejects CSRF, foreign workout IDs and stale writes", async () => {
    const profile = store.profile(alice.session.user.id);
    expect((await request("/api/profile", alice, "PUT", profile, { "X-CSRF-Token": "forged" })).status).toBe(403);
    expect((await request("/api/profile", alice, "PUT", profile, { Origin: "https://other.example" })).status).toBe(403);
    expect((await request("/api/profile", alice, "PUT", profile)).status).toBe(200);
    expect((await request("/api/profile", alice, "PUT", profile)).status).toBe(409);
    const created = await request("/api/workouts", alice, "POST", runningExplicitWorkout);
    const saved = created.data as { data: { id: string }; revision: number };
    expect(created.status).toBe(201);
    expect((await request("/api/workouts", bob)).data).toEqual([]);
    expect((await request(`/api/workouts/${saved.data.id}`, bob)).status).toBe(404);
    expect((await request(`/api/workouts/${saved.data.id}`, bob, "PUT", { data: runningExplicitWorkout, revision: 1 })).status).toBe(404);
    expect((await request(`/api/workouts/${saved.data.id}`, alice, "PUT", { data: runningExplicitWorkout, revision: 1 })).status).toBe(200);
    expect((await request(`/api/workouts/${saved.data.id}`, alice, "PUT", { data: runningExplicitWorkout, revision: 1 })).status).toBe(409);
    expect((await request("/api/local/garmin/status", alice, "POST")).status).toBe(404);
  });
  it("isolates simultaneous Garmin MFA by user and originating app session", async () => {
    const credentials = { email: "person@example.invalid", password: "not-stored" };
    expect((await request("/api/garmin/login", alice, "POST", credentials)).data).toMatchObject({ code: "MFA_REQUIRED" });
    expect((await request("/api/garmin/login", bob, "POST", credentials)).data).toMatchObject({ code: "MFA_REQUIRED" });
    expect(factory.mock.calls.map(call => call[0])).toContain(join(directory, "garmin", alice.session.user.id));
    expect(factory.mock.calls.map(call => call[0])).toContain(join(directory, "garmin", bob.session.user.id));
    const otherAliceSession = (await store.login("alice", changed))!;
    expect((await request("/api/garmin/mfa", otherAliceSession, "POST", { code: "123456" })).data).toMatchObject({ code: "BUSY" });
    expect((await request("/api/garmin/cancel", otherAliceSession, "POST")).data).toMatchObject({ code: "AUTH_REQUIRED" });
    expect((await request("/api/garmin/cancel", bob, "POST")).data).toMatchObject({ code: "CANCELLED" });
    expect((await request("/api/garmin/mfa", alice, "POST", { code: "123456" })).data).toMatchObject({ code: "READY" });
    expect((await request("/api/garmin/mfa", bob, "POST", { code: "123456" })).data).toMatchObject({ code: "AUTH_REQUIRED" });
    await request("/api/garmin/login", otherAliceSession, "POST", credentials);
    expect((await request("/api/auth/logout", otherAliceSession, "POST")).status).toBe(200);
    expect((await request("/api/garmin/mfa", otherAliceSession, "POST", { code: "123456" })).status).toBe(401);
    expect((await request("/api/garmin/status", alice, "POST")).data).toMatchObject({ code: "READY" });
  }, 30000);
  it("routes sends and disconnects through each user's own bridge", async () => {
    const body = { workout: runningExplicitWorkout, profile: completeProfile, date: "2026-10-15", operationId: "33333333-3333-4333-8333-333333333333" };
    for (const client of [alice, bob]) {
      expect((await request("/api/garmin/send", client, "POST", body)).data).toMatchObject({ code: "SCHEDULED" });
      const index = factory.mock.calls.findIndex(call => call[0] === join(directory, "garmin", client.session.user.id));
      const bridge = factory.mock.results[index]!.value;
      expect(bridge.run).toHaveBeenCalledWith("send", expect.objectContaining({ operationId: body.operationId }));
    }
    await request("/api/garmin/logout", bob, "POST");
    const aliceIndex = factory.mock.calls.findIndex(call => call[0] === join(directory, "garmin", alice.session.user.id));
    expect(factory.mock.results[aliceIndex]!.value.run).not.toHaveBeenCalledWith("logout", undefined);
  });
});
