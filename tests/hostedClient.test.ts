import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const user = { id: "11111111-1111-4111-8111-111111111111", username: "alice", mustChangePassword: false };
const csrfToken = "a".repeat(64);
const response = (data: unknown, headers?: Record<string, string>) => new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json", ...headers } });

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("window", Object.assign(new EventTarget(), { location: { hostname: "workouts.example" }, __WORKOUT_BUILDER_SHARED__: true }));
  vi.stubGlobal("document", { querySelectorAll: () => [] });
});
afterEach(() => vi.unstubAllGlobals());

describe("hosted browser account boundaries", () => {
  it("adds CSRF in memory and namespaces browser data by authenticated user", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response({ user, csrfToken }));
    vi.stubGlobal("fetch", fetcher);
    const client = await import("../src/ui/hostedClient.js");
    await client.restoreHostedSession();
    expect(client.userStorageKey("draft")).toContain(user.id);
    await client.hostedRequest("/api/profile", "PUT", {});
    const init = fetcher.mock.calls.at(-1)?.[1] as RequestInit | undefined;
    expect(new Headers(init?.headers).get("X-CSRF-Token")).toBe(csrfToken);
    expect(init?.credentials).toBe("same-origin");
  });
  it("discards a previous account's late response after sign-out", async () => {
    let finish: ((response: Response) => void) | undefined;
    vi.stubGlobal("fetch", vi.fn(async (path: string) => path === "/api/profile"
      ? new Promise<Response>(resolve => { finish = resolve; })
      : response(path.endsWith("session") ? { user, csrfToken } : { ok: true })));
    const client = await import("../src/ui/hostedClient.js");
    await client.restoreHostedSession();
    const pending = expect(client.hostedRequest("/api/profile")).rejects.toThrow("Account changed");
    await client.signOut();
    finish!(response({ private: "alice" })); await pending;
    expect(client.getHostedSession()).toBeUndefined();
    expect(client.userStorageKey("draft")).not.toContain(user.id);
  });
  it("clears personal state on session expiry and an account switch in another tab", async () => {
    let next = response({ user, csrfToken });
    vi.stubGlobal("fetch", vi.fn(async () => next));
    const client = await import("../src/ui/hostedClient.js");
    await client.restoreHostedSession();
    next = response({ private: "bob" }, { "X-Workout-User": "22222222-2222-4222-8222-222222222222" });
    await expect(client.hostedRequest("/api/profile")).rejects.toThrow("Account changed");
    expect(client.getHostedSession()).toBeUndefined();
    next = response({ user, csrfToken }); await client.restoreHostedSession();
    next = new Response('{}', { status: 401 });
    await expect(client.hostedRequest("/api/profile")).rejects.toThrow("Sign in again");
    expect(client.getHostedSession()).toBeUndefined();
  });
  it("prevents an old parser retry from sending a prompt under a new account", async () => {
    const fetcher = vi.fn(async () => response({ user, csrfToken }));
    vi.stubGlobal("fetch", fetcher);
    const client = await import("../src/ui/hostedClient.js");
    await client.restoreHostedSession();
    const oldParserFetch = client.accountFetch();
    await client.signOut();
    await client.restoreHostedSession();
    const calls = fetcher.mock.calls.length;
    await expect(oldParserFetch("/api/inference/v1/chat/completions")).rejects.toThrow("Account changed");
    expect(fetcher).toHaveBeenCalledTimes(calls);
  });
});
