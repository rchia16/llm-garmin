import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { AccountError, type Session } from "./accounts.js";
import type { HostedApi } from "./hostedApi.js";

const MAX_BODY_BYTES = 65_536;
const MAX_RESPONSE_BYTES = 131_072;
const generationSchema = z.object({
  model: z.string().max(200).optional(),
  messages: z.array(z.object({ role: z.enum(["system", "user"]), content: z.string().max(24_000) }).strict()).min(1).max(4),
  temperature: z.literal(0),
  max_tokens: z.number().int().min(1).max(8192),
  chat_template_kwargs: z.object({ enable_thinking: z.literal(false) }).strict(),
  response_format: z.object({
    type: z.literal("json_schema"),
    json_schema: z.object({ name: z.literal("workout_interpretation"), strict: z.literal(true), schema: z.record(z.unknown()) }).strict(),
  }).strict(),
}).strict();
const completionSchema = z.object({ choices: z.array(z.object({
  message: z.object({ content: z.string().max(MAX_RESPONSE_BYTES).nullable() }),
  finish_reason: z.string().nullable().optional(),
})).min(1).max(1) });

export type SharedServerOptions = {
  publicOrigin: string;
  staticDirectory: string;
  inferenceUrl?: string;
  inferenceApiKey?: string;
  fetch?: typeof fetch;
  hosted?: HostedApi;
};

async function boundedBody(source: AsyncIterable<unknown>, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of source) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (bytes > limit) throw new Error("BODY_TOO_LARGE");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Hosted accounts are injected; local machine controls are never exposed here. */
export function createSharedServer(options: SharedServerOptions) {
  const origin = new URL(options.publicOrigin);
  if (origin.protocol !== "https:" || origin.origin !== options.publicOrigin) throw new Error("PUBLIC_ORIGIN must be an HTTPS origin without a trailing slash or path.");
  const upstream = new URL(options.inferenceUrl ?? "http://127.0.0.1:8081/v1");
  // Only a loopback model is accepted; the browser cannot choose a destination.
  if (upstream.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(upstream.hostname)
    || upstream.username || upstream.password || upstream.search || upstream.hash || upstream.pathname !== "/v1") {
    throw new Error("INFERENCE_URL must be a loopback HTTP /v1 endpoint.");
  }
  const requestFetch = options.fetch ?? fetch;
  let active = 0;
  let budgetStartedAt = 0;
  let requestsInWindow = 0;
  const json = (response: ServerResponse, status: number, body: unknown): void => {
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(body));
  };
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    // Host is checked against a configured origin, never trusted forwarded headers.
    if (request.headers.host !== origin.host) { json(response, 403, { error: "FORBIDDEN" }); return; }
    const path = request.url?.split("?")[0] ?? "";
    if (path === "/api/shared/health" && request.method === "GET") {
      try {
        const result = await requestFetch(`${upstream.origin}/health`, {
          redirect: "manual", signal: AbortSignal.timeout(4000),
          headers: options.inferenceApiKey ? { Authorization: `Bearer ${options.inferenceApiKey}` } : {},
        });
        json(response, 200, { state: result.status === 200 ? "ready" : result.status === 503 ? "loading" : "offline" });
      } catch { json(response, 200, { state: "offline" }); }
      return;
    }
    if (options.hosted && await options.hosted.handle(request, response, path)) return;
    if (path === "/api/inference/v1/chat/completions") {
      let session: Session | undefined;
      if (options.hosted) {
        try {
          session = options.hosted.authenticate(request, true);
          response.setHeader("X-Workout-User", session.user.id);
          if (session.user.mustChangePassword) throw new AccountError(403, "PASSWORD_CHANGE_REQUIRED");
        } catch (error) { options.hosted.error(response, error); return; }
      }
      if (request.method !== "POST" || request.headers.origin !== origin.origin
        || !/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
        json(response, 403, { error: "FORBIDDEN" }); return;
      }
      if (Date.now() - budgetStartedAt >= 60_000) { budgetStartedAt = Date.now(); requestsInWindow = 0; }
      // A global limit is intentional: no IP/user tracking and no trust in proxy headers.
      if ((!options.hosted && active >= 2) || requestsInWindow >= 30) {
        response.setHeader("Retry-After", "60");
        json(response, 429, { error: "INFERENCE_BUSY" }); return;
      }
      if (Number(request.headers["content-length"] ?? 0) > MAX_BODY_BYTES) { json(response, 413, { error: "BODY_TOO_LARGE" }); return; }
      let release: (() => void) | undefined;
      const abort = new AbortController();
      const disconnected = (): void => { if (!response.writableEnded) abort.abort(); };
      response.on("close", disconnected);
      active += 1;
      requestsInWindow += 1;
      try {
        let payload: z.infer<typeof generationSchema>;
        try { payload = generationSchema.parse(JSON.parse(await boundedBody(request, MAX_BODY_BYTES))); }
        catch (error) { json(response, error instanceof Error && error.message === "BODY_TOO_LARGE" ? 413 : 400, { error: "INVALID_REQUEST" }); return; }
        if (options.hosted && session) {
          release = await options.hosted.queue.acquire(session.user.id, session.id, abort.signal);
          options.hosted.assertSession(session);
        }
        const result = await requestFetch(`${upstream.href}/chat/completions`, {
          method: "POST", redirect: "manual", signal: AbortSignal.any([AbortSignal.timeout(90_000), abort.signal]),
          headers: { "Content-Type": "application/json", ...(options.inferenceApiKey ? { Authorization: `Bearer ${options.inferenceApiKey}` } : {}) },
          body: JSON.stringify(payload),
        });
        if (!result.ok || !result.body) { json(response, 502, { error: "INFERENCE_UNAVAILABLE" }); return; }
        // Strip upstream metadata/errors; never echo configuration or credentials.
        const completion = completionSchema.parse(JSON.parse(await boundedBody(result.body, MAX_RESPONSE_BYTES)));
        if (options.hosted && session) options.hosted.assertSession(session);
        json(response, 200, completion);
      } catch (error) {
        if (options.hosted && error instanceof AccountError) options.hosted.error(response, error);
        else if (!response.destroyed) json(response, 502, { error: "INFERENCE_UNAVAILABLE" });
      }
      finally { active -= 1; release?.(); response.off("close", disconnected); }
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") { json(response, 404, { error: "NOT_FOUND" }); return; }
    if (path === "/app-mode.js") {
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      response.end(request.method === "HEAD" ? undefined : "window.__WORKOUT_BUILDER_SHARED__ = true;");
      return;
    }
    // Serve only the built entry point and flat Vite assets. No directory listing,
    // SPA fallback, source maps, dotfiles, databases, or arbitrary file paths.
    const filename = path === "/" || path === "/index.html" ? "index.html"
      : /^\/assets\/[A-Za-z0-9_-]+\.(?:js|css)$/.test(path) ? path.slice(1) : undefined;
    if (!filename) { json(response, 404, { error: "NOT_FOUND" }); return; }
    try {
      const contents = await readFile(resolve(options.staticDirectory, filename));
      const contentType = filename.endsWith(".js") ? "text/javascript" : filename.endsWith(".css") ? "text/css" : "text/html";
      response.writeHead(200, { "Content-Type": `${contentType}; charset=utf-8` });
      response.end(request.method === "HEAD" ? undefined : contents);
    } catch { json(response, 404, { error: "NOT_FOUND" }); }
  };
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) json(response, 500, { error: "SERVER_ERROR" });
      else response.destroy();
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 50;
  return server;
}
