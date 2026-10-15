import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), exists: vi.fn(() => true) }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("node:fs", () => ({ existsSync: mocks.exists }));
import { createGarminAuth } from "../src/local/garminAuth.js";

function fakeChild() {
  const process = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  mocks.spawn.mockReturnValue(process);
  return process;
}
const credentials = { email: "test@example.invalid", password: "dummy-secret" };
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); mocks.exists.mockReturnValue(true); });

describe("Garmin login subprocess protocol (no live account)", () => {
  it("passes a trusted hosted directory and suppresses owner Garmin configuration", async () => {
    const child = fakeChild();
    const auth = createGarminAuth("/private/users/alice");
    const pending = auth("login", credentials);
    expect(mocks.spawn.mock.calls[0]?.[2].env).toMatchObject({ GARMIN_HOSTED: "1", GARMIN_SESSION_DIR: "/private/users/alice", GARMIN_EMAIL: "" });
    child.stdout.write('{"ok":true,"code":"READY"}\n');
    await pending;
  });
  it("keeps credentials off argv/env and continues MFA in the same process", async () => {
    const child = fakeChild();
    const auth = createGarminAuth();
    const first = auth("login", credentials);
    expect(child.stdin.read().toString()).toBe(JSON.stringify(credentials) + "\n");
    expect(JSON.stringify(mocks.spawn.mock.calls)).not.toContain("dummy-secret");
    child.stdout.write('{"ok":false,"code":"MFA_');
    child.stdout.write('REQUIRED"}\n');
    expect(await first).toEqual({ ok: false, code: "MFA_REQUIRED" });
    expect(await auth("login", credentials)).toEqual({ ok: false, code: "BUSY" });
    const second = auth("mfa", { code: "123456" });
    expect(child.stdin.read().toString()).toBe('{"code":"123456"}\n');
    child.stdout.write('{"ok":true,"code":"READY"}\n');
    expect(await second).toEqual({ ok: true, code: "READY" });
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(await auth("mfa", { code: "123456" })).toEqual({ ok: false, code: "AUTH_REQUIRED" });
  });

  it("cancels a pending login and discards late subprocess output", async () => {
    const child = fakeChild();
    const auth = createGarminAuth();
    const pending = auth("login", credentials);
    expect(await auth("cancel")).toEqual({ ok: false, code: "CANCELLED" });
    expect(await pending).toEqual({ ok: false, code: "CANCELLED" });
    child.stdout.write('{"ok":true,"code":"READY"}\n');
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("expires abandoned MFA and allows a fresh login", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const auth = createGarminAuth();
    const first = auth("login", credentials);
    child.stdout.write('{"ok":false,"code":"MFA_REQUIRED"}\n');
    await first;
    await vi.advanceTimersByTimeAsync(180_000);
    expect(child.kill).toHaveBeenCalledOnce();
    const next = fakeChild();
    const retry = auth("login", credentials);
    next.stdout.write('{"ok":false,"code":"AUTH_REQUIRED"}\n');
    expect(await retry).toEqual({ ok: false, code: "AUTH_REQUIRED" });
  });

  it("bounds output and never returns raw subprocess errors", async () => {
    const child = fakeChild();
    const auth = createGarminAuth();
    const pending = auth("login", credentials);
    child.stderr.write("token=secret".repeat(2000));
    expect(await pending).toEqual({ ok: false, code: "BRIDGE_FAILED" });
    expect(child.kill).toHaveBeenCalledOnce();
  });
});
