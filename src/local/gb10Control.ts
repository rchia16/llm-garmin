import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { IncomingMessage, ServerResponse } from "node:http";

const execFileAsync = promisify(execFile);
const remote = "rchia@100.76.243.123";
const keyPath = join(homedir(), ".ssh", "llm_garmin_gb10");
const startCommand = "systemctl --user daemon-reload && systemctl --user enable --now llm-garmin.service && tailscale serve --bg --https=8443 localhost:8081";
const healthUrl = "https://promaxgb10-4e2b.tail06a565.ts.net:8443/health";

export type Gb10Health = "ready" | "loading" | "offline" | "unknown";

type CommandRunner = (file: string, args: string[]) => Promise<void>;

async function runCommand(file: string, args: string[]): Promise<void> {
  await execFileAsync(file, args, { timeout: 45_000, maxBuffer: 16_384, windowsHide: true });
}

export function isAuthorizedLocalControlRequest(request: IncomingMessage, action: "start" | "status" = "start"): boolean {
  const host = request.headers.host;
  const address = request.socket.remoteAddress;
  return request.method === "POST"
    && typeof host === "string"
    && /^127\.0\.0\.1:\d+$/.test(host)
    && request.headers.origin === `http://${host}`
    && request.headers["x-llm-garmin-control"] === action
    && (address === "127.0.0.1" || address === "::ffff:127.0.0.1");
}

/** A fixed, bounded probe: no browser-supplied URL, credentials, or remote command. */
export async function probeGb10Health(fetcher: typeof fetch = fetch): Promise<Gb10Health> {
  try {
    const response = await fetcher(healthUrl, {
      signal: AbortSignal.timeout(4_000),
      redirect: "manual",
      cache: "no-store",
    });
    if (response.status === 200) return "ready";
    if (response.status === 503) return "loading";
    if (response.status === 502 || response.status === 504) return "offline";
    return "unknown";
  } catch {
    return "offline";
  }
}

/** Only this fixed service and Tailscale port can be controlled; browser data is never passed to SSH. */
export async function startGb10Server(run: CommandRunner = runCommand, hasKey = existsSync): Promise<void> {
  if (!hasKey(keyPath)) throw new Error("SSH_KEY_MISSING");
  await run("ssh", [
    "-T",
    "-i", keyPath,
    "-o", "BatchMode=yes",
    "-o", "NumberOfPasswordPrompts=0",
    "-o", "IdentitiesOnly=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", "ConnectTimeout=8",
    remote,
    startCommand,
  ]);
}

function safeFailureMessage(error: unknown): string {
  if (error instanceof Error && error.message === "SSH_KEY_MISSING") {
    return "SSH key missing: create ~/.ssh/llm_garmin_gb10 and install its public key on GB10.";
  }
  const details = error instanceof Error
    ? `${error.message} ${"stderr" in error && typeof error.stderr === "string" ? error.stderr : ""}`
    : "";
  if (/Host key verification failed|No ED25519 host key is known/i.test(details)) {
    return "GB10 host key is not trusted yet. Verify and add it to your SSH known_hosts.";
  }
  if (/Permission denied|passphrase/i.test(details)) {
    return "SSH key authentication failed. Check authorized_keys and unlock the key in ssh-agent if it has a passphrase.";
  }
  if (/Unit llm-garmin\.service not found|does not exist/i.test(details)) {
    return "llm-garmin.service is not installed on GB10. Install the service before using this button.";
  }
  return "Could not start GB10 service. Check SSH access and the GB10 user-service and Tailscale logs.";
}

export async function handleGb10Start(
  request: IncomingMessage,
  response: ServerResponse,
  start: () => Promise<void> = startGb10Server,
): Promise<void> {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  if (!isAuthorizedLocalControlRequest(request)) {
    response.statusCode = 403;
    response.end(JSON.stringify({ ok: false, message: "GB10 control is available only from this local app." }));
    return;
  }
  try {
    await start();
    response.statusCode = 200;
    response.end(JSON.stringify({ ok: true, message: "GB10 startup requested. The model may need time to load." }));
  } catch (error) {
    response.statusCode = 502;
    response.end(JSON.stringify({ ok: false, message: safeFailureMessage(error) }));
  }
}

export async function handleGb10Status(
  request: IncomingMessage,
  response: ServerResponse,
  probe: () => Promise<Gb10Health> = probeGb10Health,
): Promise<void> {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  if (!isAuthorizedLocalControlRequest(request, "status")) {
    response.statusCode = 403;
    response.end(JSON.stringify({ ok: false, message: "GB10 status is available only from this local app." }));
    return;
  }
  response.statusCode = 200;
  response.end(JSON.stringify({ ok: true, state: await probe() }));
}
