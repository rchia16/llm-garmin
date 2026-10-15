import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { garminEnvironment, garminLoginSchema, garminMfaSchema, root, type GarminAction } from "./garminControl.js";
import { garminResultSchema, type GarminResult } from "./garminProtocol.js";

// One short-lived login process, holding the Python storage lock through MFA.
// Credentials are stdin data, never shell arguments, environment, or log output.
export function createGarminAuth(sessionDirectory?: string) {
  let child: ChildProcessWithoutNullStreams | undefined;
  let waiting: ((result: GarminResult) => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let needsMfa = false;
  const deliver = (result: GarminResult): void => {
    const resolve = waiting;
    waiting = undefined;
    resolve?.(result);
  };
  const stop = (result: GarminResult): void => {
    clearTimeout(timer);
    const current = child;
    child = undefined;
    needsMfa = false;
    current?.kill();
    deliver(result);
  };
  return async (action: GarminAction, input?: unknown): Promise<GarminResult> => {
    if (action === "cancel") { stop({ ok: false, code: "CANCELLED" }); return { ok: false, code: "CANCELLED" }; }
    if (action === "mfa") {
      const data = garminMfaSchema.parse(input);
      if (!child || !needsMfa || waiting) return { ok: false, code: "AUTH_REQUIRED" };
      needsMfa = false;
      return new Promise((resolve) => { waiting = resolve; child?.stdin.write(JSON.stringify(data) + "\n"); });
    }
    if (action !== "login") return { ok: false, code: "INVALID_REQUEST" };
    if (child) return { ok: false, code: "BUSY" };
    const data = garminLoginSchema.parse(input);
    const executable = join(root, process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python");
    if (!existsSync(executable)) return { ok: false, code: "SETUP_REQUIRED" };
    return new Promise((resolve) => {
      waiting = resolve;
      const current = spawn(executable, [join(root, "python/garmin_bridge.py"), "web-login"], {
        cwd: root, windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"],
        env: garminEnvironment(sessionDirectory),
      });
      child = current;
      timer = setTimeout(() => stop({ ok: false, code: "BRIDGE_TIMEOUT" }), 180_000);
      timer.unref();
      let buffer = "";
      let bytes = 0;
      current.stdout.setEncoding("utf8");
      current.stdout.on("data", (chunk: string) => {
        if (child !== current) return;
        bytes += Buffer.byteLength(chunk);
        if (bytes > 16_384) { stop({ ok: false, code: "BRIDGE_FAILED" }); return; }
        buffer += chunk;
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          try {
            const result = garminResultSchema.parse(JSON.parse(line));
            if (result.code === "MFA_REQUIRED") { needsMfa = true; deliver(result); }
            else { clearTimeout(timer); child = undefined; needsMfa = false; deliver(result); current.stdin.end(); }
          } catch { stop({ ok: false, code: "BRIDGE_FAILED" }); }
        }
      });
      current.stderr.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (child === current && bytes > 16_384) stop({ ok: false, code: "BRIDGE_FAILED" });
      });
      current.on("error", () => { if (child === current) stop({ ok: false, code: "SETUP_REQUIRED" }); });
      current.on("close", () => { if (child === current) stop({ ok: false, code: "BRIDGE_FAILED" }); });
      current.stdin.on("error", () => { if (child === current) stop({ ok: false, code: "BRIDGE_FAILED" }); });
      current.stdin.write(JSON.stringify(data) + "\n");
    });
  };
}
