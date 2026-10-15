import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { athleteProfileSchema, workoutSchema } from "../domain/index.js";
import { validateIsoDate } from "../dates/index.js";
import { exportGarminConnectJson } from "../garminConnectJson/export.js";
import { garminResultSchema, type GarminResult } from "./garminProtocol.js";

export const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
export type GarminAction = "status" | "send" | "login" | "mfa" | "cancel" | "logout";
export const garminLoginSchema = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(1024) }).strict();
export const garminMfaSchema = z.object({ code: z.string().regex(/^\d{4,10}$/) }).strict();
export const MAX_GARMIN_BODY_BYTES = 1_048_576;
const requestSchema = z.object({
  workout: workoutSchema, profile: athleteProfileSchema,
  date: z.string().refine((value) => { try { validateIsoDate(value); return true; } catch { return false; } }),
  operationId: z.string().uuid(),
}).strict();

export function authorizedGarminRequest(request: IncomingMessage, action: GarminAction): boolean {
  const host = request.headers.host;
  return request.method === "POST"
    && typeof host === "string" && /^(?:localhost|127\.0\.0\.1|\[::1\]):\d+$/.test(host)
    && request.headers.origin === `http://${host}`
    && request.headers["x-llm-garmin-control"] === `garmin-${action}`
    && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? "");
}

export function prepareGarminSend(input: unknown): { operationId: string; date: string; workout: Record<string, unknown> } {
  const request = requestSchema.parse(input);
  const exported = exportGarminConnectJson(request.workout, request.profile);
  return { operationId: request.operationId, date: request.date, workout: exported.workout };
}

export type GarminRunner = (command: "status" | "send" | "logout", input?: unknown) => Promise<GarminResult>;
export function garminEnvironment(sessionDirectory?: string): NodeJS.ProcessEnv {
  return { ...process.env, PYTHONUTF8: "1", PYTHONUNBUFFERED: "1", PYTHONDONTWRITEBYTECODE: "1",
    ...(sessionDirectory === undefined ? {} : { GARMIN_HOSTED: "1", GARMIN_SESSION_DIR: sessionDirectory, GARMIN_EMAIL: "" }) };
}

export function createGarminRunner(sessionDirectory?: string): GarminRunner {
  return async (command, input) => {
    const executable = join(root, process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python");
    if (!existsSync(executable)) return { ok: false, code: "SETUP_REQUIRED" };
    return new Promise((resolve) => {
      const child = spawn(executable, [join(root, "python/garmin_bridge.py"), command], {
        cwd: root, windowsHide: true, shell: false,
        env: garminEnvironment(sessionDirectory),
        stdio: ["pipe", "pipe", "pipe"],
      });
      let output = "";
      let bytes = 0;
      let settled = false;
      const finish = (result: GarminResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        child.kill();
        finish({ ok: false, code: "BRIDGE_TIMEOUT" });
      }, command === "status" ? 30_000 : 90_000);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 16_384) { child.kill(); finish({ ok: false, code: "BRIDGE_FAILED" }); }
        else output += chunk;
      });
      child.stderr.on("data", (chunk: Buffer) => {
        // Never forward third-party stderr; count it to bound runaway output.
        bytes += chunk.length;
        if (bytes > 16_384) { child.kill(); finish({ ok: false, code: "BRIDGE_FAILED" }); }
      });
      child.on("error", () => finish({ ok: false, code: "SETUP_REQUIRED" }));
      child.stdin.on("error", () => { /* EPIPE is handled by the exit/result path. */ });
      child.on("close", () => {
        try { finish(garminResultSchema.parse(JSON.parse(output))); }
        catch { finish({ ok: false, code: "BRIDGE_FAILED" }); }
      });
      child.stdin.end(input === undefined ? "" : JSON.stringify(input));
    });
  };
}

export const runGarminBridge: GarminRunner = createGarminRunner();

async function readBody(request: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) throw new Error("INVALID_REQUEST");
  const declared = Number(request.headers["content-length"] ?? 0);
  if (declared > MAX_GARMIN_BODY_BYTES) throw new Error("BODY_TOO_LARGE");
  const chunks: Buffer[] = [];
  let bytes = 0;
  const timeout = setTimeout(() => request.destroy(), 10_000);
  try {
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      bytes += buffer.length;
      if (bytes > MAX_GARMIN_BODY_BYTES) throw new Error("BODY_TOO_LARGE");
      chunks.push(buffer);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally { clearTimeout(timeout); }
}

export function createGarminHandler(run: GarminRunner = runGarminBridge, auth?: (action: GarminAction, input?: unknown) => Promise<GarminResult>) {
  let busy = false;
  return async (request: IncomingMessage, response: ServerResponse, action: GarminAction): Promise<void> => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    const reply = (status: number, result: GarminResult): void => {
      response.statusCode = status;
      response.end(JSON.stringify(result));
    };
    if (!authorizedGarminRequest(request, action)) { reply(403, { ok: false, code: "INVALID_REQUEST" }); return; }
    if (action === "cancel") {
      try { reply(200, garminResultSchema.parse(await auth?.(action) ?? { ok: false, code: "CANCELLED" })); }
      catch { reply(502, { ok: false, code: "BRIDGE_FAILED" }); }
      return;
    }
    if (busy) { reply(409, { ok: false, code: "BUSY" }); return; }
    busy = true;
    try {
      let input: unknown;
      if (["send", "login", "mfa"].includes(action)) {
        try {
          const body = await readBody(request);
          input = action === "send" ? prepareGarminSend(body) : action === "login" ? garminLoginSchema.parse(body) : garminMfaSchema.parse(body);
        }
        catch (error) {
          reply(error instanceof Error && error.message === "BODY_TOO_LARGE" ? 413 : 400, { ok: false, code: "INVALID_REQUEST" });
          return;
        }
      }
      const result = garminResultSchema.parse(await (["login", "mfa", "cancel"].includes(action)
        ? auth?.(action, input) ?? Promise.resolve({ ok: false, code: "UNAVAILABLE" })
        : run(action as "status" | "send" | "logout", input)));
      // No prompts, tokens, raw errors, or workout content in diagnostics.
      if (action === "send") console.info("garmin-send", { code: result.code, workoutId: result.workoutId });
      reply(result.ok ? 200 : 502, result);
    } catch { reply(502, { ok: false, code: "BRIDGE_FAILED" }); }
    finally { busy = false; }
  };
}
