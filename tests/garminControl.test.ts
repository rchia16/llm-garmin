import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { authorizedGarminRequest, createGarminHandler, MAX_GARMIN_BODY_BYTES, prepareGarminSend } from "../src/local/garminControl.js";
import { garminConfirmation, garminOperationId, requestGarmin } from "../src/ui/garminClient.js";
import { garminResultSchema } from "../src/local/garminProtocol.js";
import { resolveWorkoutTargets } from "../src/engine/index.js";
import { completeProfile } from "./fixtures/profiles.js";
import { cyclingWorkout, runningExplicitWorkout, swimmingWorkout } from "./fixtures/workouts.js";

const operationId = "12345678-1234-4234-8234-123456789abc";
const input = { workout: runningExplicitWorkout, profile: completeProfile, date: "2026-10-10", operationId };

describe("experimental local Garmin bridge", () => {
  it.each([runningExplicitWorkout, cyclingWorkout, swimmingWorkout])("uses the existing exporter for $sport", (workout) => {
    const result = prepareGarminSend({ ...input, workout: resolveWorkoutTargets(workout, completeProfile).workout });
    expect(result.operationId).toBe(operationId);
    expect(result.date).toBe("2026-10-10");
    expect(result.workout).toHaveProperty("workoutSegments");
    expect(result).not.toHaveProperty("profile");
    expect(result.workout).not.toHaveProperty("sourcePrompt");
  });

  it("rejects invalid calendar days, extra commands and unresolved targets", () => {
    expect(() => prepareGarminSend({ ...input, date: "2026-02-30" })).toThrow();
    expect(() => prepareGarminSend({ ...input, command: "delete" })).toThrow();
    expect(() => prepareGarminSend({ ...input, workout: cyclingWorkout })).toThrow("profile baseline");
  });

  it.each(["localhost:5173", "127.0.0.1:5173", "[::1]:5173"])("allows only matching loopback origin %s", (host) => {
    const request = { method: "POST", headers: { host, origin: `http://${host}`, "x-llm-garmin-control": "garmin-send" }, socket: { remoteAddress: "::1" } } as IncomingMessage;
    expect(authorizedGarminRequest(request, "send")).toBe(true);
    expect(authorizedGarminRequest({ ...request, headers: { ...request.headers, origin: "https://evil.test" } } as IncomingMessage, "send")).toBe(false);
    expect(authorizedGarminRequest({ ...request, socket: { remoteAddress: "192.168.1.2" } } as IncomingMessage, "send")).toBe(false);
  });

  it("traces browser payload through validation, exporter and bridge without leaking errors", async () => {
    const runner = vi.fn(async () => ({ ok: true, code: "SCHEDULED" as const, workoutId: 42, date: input.date }));
    const handler = createGarminHandler(runner);
    const server = createServer((request, response) => void handler(request, response, request.url === "/status" ? "status" : "send"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const send = (body: string, extra: Record<string, string> = {}) => fetch(origin, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "X-LLM-Garmin-Control": "garmin-send", ...extra }, body });
      expect((await send(JSON.stringify(input), { Origin: "https://evil.test" })).status).toBe(403);
      expect((await send("not json")).status).toBe(400);
      expect((await send(JSON.stringify({ ...input, date: "2026-02-30" }))).status).toBe(400);
      expect((await send("x".repeat(MAX_GARMIN_BODY_BYTES + 1))).status).toBe(413);
      expect(runner).not.toHaveBeenCalled();
      const response = await send(JSON.stringify(input));
      expect(await response.json()).toMatchObject({ ok: true, workoutId: 42 });
      expect(runner).toHaveBeenCalledWith("send", prepareGarminSend(input));
      runner.mockImplementationOnce(async () => { throw new Error("password=secret token=private"); });
      const failure = await send(JSON.stringify(input));
      expect(await failure.text()).toBe('{"ok":false,"code":"BRIDGE_FAILED"}');
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  it("blocks concurrent clicks until the first operation finishes", async () => {
    let release!: () => void;
    const handler = createGarminHandler(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return { ok: true, code: "READY" };
    });
    const server = createServer((request, response) => void handler(request, response, "status"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const options = { method: "POST", headers: { Origin: origin, "X-LLM-Garmin-Control": "garmin-status" } };
      const first = fetch(origin, options);
      await vi.waitFor(() => expect(release).toBeDefined());
      expect((await fetch(origin, options)).status).toBe(409);
      release();
      expect((await first).status).toBe(200);
    } finally { release?.(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  it("shows compatibility warnings and date before external writes", () => {
    const swim = resolveWorkoutTargets(swimmingWorkout, completeProfile).workout;
    const message = garminConfirmation(swim, completeProfile, input.date);
    expect(message).toContain("2026-10-10");
    expect(message).toContain("secondary target");
    expect(message).toContain("changes your Garmin account");
  });

  it("protects login endpoints, validates credentials and cancels while login is waiting", async () => {
    let release!: (result: { ok: false; code: "CANCELLED" }) => void;
    const auth = vi.fn(async (action: string) => {
      if (action === "cancel") { release?.({ ok: false, code: "CANCELLED" }); return { ok: false, code: "CANCELLED" as const }; }
      return new Promise<{ ok: false; code: "CANCELLED" }>((resolve) => { release = resolve; });
    });
    const runner = vi.fn();
    const handler = createGarminHandler(runner, auth);
    const server = createServer((request, response) => void handler(request, response, request.url === "/cancel" ? "cancel" : "login"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const send = (path: string, body: unknown, from = origin) => fetch(origin + path, { method: "POST", headers: { Origin: from, "Content-Type": "application/json", "X-LLM-Garmin-Control": `garmin-${path.slice(1)}` }, body: JSON.stringify(body) });
      expect((await send("/login", { email: "test@example.invalid", password: "dummy" }, "https://evil.test")).status).toBe(403);
      expect((await send("/login", { email: "not-email", password: "dummy" })).status).toBe(400);
      expect((await send("/login", { email: "test@example.invalid", password: "dummy", command: "send" })).status).toBe(400);
      expect(auth).not.toHaveBeenCalled();
      const pending = send("/login", { email: "test@example.invalid", password: "dummy" });
      await vi.waitFor(() => expect(release).toBeDefined());
      expect((await send("/cancel", {})).status).toBe(200);
      expect(await (await pending).json()).toEqual({ ok: false, code: "CANCELLED" });
      expect(runner).not.toHaveBeenCalled();
    } finally { release?.({ ok: false, code: "CANCELLED" }); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  it("retains the operation ID across reloads and changes it for changed exports", async () => {
    const entries = new Map<string, string>();
    const storage = { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value); } } as Storage;
    const first = await garminOperationId(input.workout, input.profile, input.date, storage);
    expect(await garminOperationId(input.workout, input.profile, input.date, storage)).toBe(first);
    expect(await garminOperationId(input.workout, input.profile, "2026-10-11", storage)).not.toBe(first);
    expect([...entries.values()].join()).not.toContain(input.workout.name);
  });

  it("degrades on static hosting, subprocess errors and timeouts", async () => {
    expect(await requestGarmin("status", undefined, async () => new Response("<html>static app</html>"))).toEqual({ ok: false, code: "UNAVAILABLE" });
    expect(await requestGarmin("send", input, async () => { throw new DOMException("timed out", "TimeoutError"); })).toEqual({ ok: false, code: "BRIDGE_TIMEOUT" });
    expect(await requestGarmin("status", undefined, async () => new Response('{"ok":false,"code":"SETUP_REQUIRED"}'))).toEqual({ ok: false, code: "SETUP_REQUIRED" });
    expect(garminResultSchema.safeParse({ ok: true, code: "AUTH_REQUIRED" }).success).toBe(false);
  });
});
