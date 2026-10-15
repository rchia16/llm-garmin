import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { request as httpRequest, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSharedServer } from "../src/shared/server.js";
import { LlamaServerProvider } from "../src/llm/llamaServer.js";

const publicOrigin = "https://workouts.example:8443";
let directory: string;
let server: Server;
let localUrl: string;
const upstreamFetch = vi.fn<typeof fetch>();
const headers = { Host: "workouts.example:8443", Origin: publicOrigin, "Content-Type": "application/json" };
const payload = {
  messages: [{ role: "user", content: "Tomorrow run 30 minutes" }], temperature: 0, max_tokens: 3072,
  chat_template_kwargs: { enable_thinking: false },
  response_format: { type: "json_schema", json_schema: { name: "workout_interpretation", strict: true, schema: { type: "object" } } },
};
const completion = { choices: [{ message: { content: '{"sport":"running"}' }, finish_reason: "stop" }] };

// Node 24 fetch ignores a custom Host header. Use the HTTP client to simulate
// the original HTTPS Host/Origin preserved by the reverse proxy.
const request: typeof fetch = async (input, init) => {
  return new Promise<Response>((resolve, reject) => {
    const outgoing = httpRequest(String(input), {
      method: init?.method ?? "GET", headers: Object.fromEntries(new Headers(init?.headers)),
    }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
        }
        resolve(new Response(Buffer.concat(chunks), { status: incoming.statusCode ?? 500, headers: responseHeaders }));
      });
      incoming.on("error", reject);
    });
    outgoing.on("error", reject);
    outgoing.end(init?.body);
  });
};

describe("shared server account isolation", () => {
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "workout-shared-"));
    await mkdir(join(directory, "assets"));
    await writeFile(join(directory, "index.html"), "<div id=app></div>");
    await writeFile(join(directory, "assets/index-test.js"), "console.log('app')");
    await writeFile(join(directory, ".env"), "SECRET=private");
    upstreamFetch.mockReset();
    upstreamFetch.mockImplementation(async () => new Response(JSON.stringify(completion)));
    server = createSharedServer({ publicOrigin, staticDirectory: directory, inferenceApiKey: "private-model-key", fetch: upstreamFetch });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    localUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const get = (path: string) => request(`${localUrl}${path}`, { headers: { Host: headers.Host } });
  const post = (body: unknown, extra: Record<string, string> = {}) => request(`${localUrl}/api/inference/v1/chat/completions`, {
    method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body),
  });

  it("serves the built app with restrictive headers and server-controlled shared mode", async () => {
    const response = await get("/");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("connect-src 'self'");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await (await get("/app-mode.js")).text()).toBe("window.__WORKOUT_BUILDER_SHARED__ = true;");
    expect((await get("/assets/index-test.js")).status).toBe(200);
    expect((await fetch(localUrl)).status).toBe(403);
  });

  it("never exposes local controls or private files even with spoofed local-control headers", async () => {
    for (const path of ["/.env", "/src/local/garminAuth.ts", "/data/workouts.db", "/assets/index-test.js.map", "/assets/..%2F.env", "/api/local/garmin/status", "/api/local/garmin/login", "/api/local/garmin/send", "/api/local/gb10/start"]) {
      expect((await get(path)).status).toBe(404);
      const response = await request(`${localUrl}${path}`, {
        method: "POST", headers: { ...headers, "X-LLM-Garmin-Control": "garmin-send" }, body: "{}",
      });
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain("private");
    }
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("rejects cross-origin, arbitrary upstream options, invalid JSON and excessive bodies", async () => {
    expect((await post(payload, { Origin: "https://evil.example" })).status).toBe(403);
    expect((await post(payload, { "Content-Type": "text/plain" })).status).toBe(403);
    expect((await post({ ...payload, url: "https://evil.example", stream: true })).status).toBe(400);
    expect((await post({ ...payload, max_tokens: 100_000 })).status).toBe(400);
    expect((await post({ ...payload, messages: [{ role: "user", content: "x".repeat(70_000) }] })).status).toBe(413);
    expect(upstreamFetch).not.toHaveBeenCalled();
    expect(() => createSharedServer({ publicOrigin, staticDirectory: directory, inferenceUrl: "http://192.168.1.1/v1" })).toThrow("loopback");
  });

  it("uses the existing provider contract, sends only server credentials upstream and strips metadata", async () => {
    upstreamFetch.mockResolvedValueOnce(new Response(JSON.stringify({ ...completion, api_key: "private-model-key" })));
    const provider = new LlamaServerProvider({
      baseUrl: `${localUrl}/api/inference/v1`,
      fetch: async (url, options) => request(url, { ...options, headers: { ...options?.headers, ...headers, Authorization: "Bearer visitor-key" } }),
    });
    expect(await provider.generateStructured({ messages: [{ role: "user", content: "Run 30 min" }], jsonSchema: { type: "object" }, maxTokens: 3072 })).toEqual({ sport: "running" });
    const [url, options] = upstreamFetch.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8081/v1/chat/completions");
    expect(options?.headers).toEqual({ "Content-Type": "application/json", Authorization: "Bearer private-model-key" });
    expect(options?.redirect).toBe("manual");
    expect(options?.body).not.toContain("visitor-key");
  });

  it("sanitizes upstream failures and bounds responses", async () => {
    upstreamFetch.mockResolvedValueOnce(new Response("token=secret password=private", { status: 500 }));
    expect(await (await post(payload)).json()).toEqual({ error: "INFERENCE_UNAVAILABLE" });
    upstreamFetch.mockRejectedValueOnce(new Error("private-model-key"));
    expect(await (await post(payload)).json()).toEqual({ error: "INFERENCE_UNAVAILABLE" });
    upstreamFetch.mockResolvedValueOnce(new Response("x".repeat(140_000)));
    expect((await post(payload)).status).toBe(502);
  });

  it("limits the global inference budget without relying on visitor IP headers", async () => {
    for (let index = 0; index < 30; index += 1) {
      expect((await post(payload, { "X-Forwarded-For": `192.0.2.${index}` })).status).toBe(200);
    }
    expect((await post(payload, { "X-Forwarded-For": "192.0.2.99" })).status).toBe(429);
    expect(upstreamFetch).toHaveBeenCalledTimes(30);
  });

  it("caps simultaneous inference requests and reports model status without metadata", async () => {
    let release!: () => void;
    upstreamFetch.mockImplementation(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return new Response(JSON.stringify(completion));
    });
    const first = post(payload);
    await vi.waitFor(() => expect(upstreamFetch).toHaveBeenCalledTimes(1));
    const releaseFirst = release;
    const second = post(payload);
    await vi.waitFor(() => expect(upstreamFetch).toHaveBeenCalledTimes(2));
    const blocked = await post(payload);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("60");
    releaseFirst(); release();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    upstreamFetch.mockResolvedValueOnce(new Response("private metadata", { status: 503 }));
    expect(await (await get("/api/shared/health")).json()).toEqual({ state: "loading" });
  });
});
