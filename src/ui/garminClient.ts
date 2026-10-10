import type { AthleteProfile, Workout } from "../domain/index.js";
import { exportGarminConnectJson } from "../garminConnectJson/export.js";
import { garminResultSchema, type GarminResult } from "../local/garminProtocol.js";

export async function requestGarmin(action: "status" | "send" | "login" | "mfa" | "cancel" | "logout", input?: unknown, fetcher: typeof fetch = fetch): Promise<GarminResult> {
  try {
    const response = await fetcher(`/api/local/garmin/${action}`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-LLM-Garmin-Control": `garmin-${action}` },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      signal: AbortSignal.timeout(action === "login" || action === "mfa" ? 185_000 : action === "send" ? 95_000 : 35_000),
    });
    const parsed = garminResultSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : { ok: false, code: "UNAVAILABLE" };
  } catch (error) {
    return { ok: false, code: error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError") ? "BRIDGE_TIMEOUT" : "UNAVAILABLE" };
  }
}

export function garminConfirmation(workout: Workout, profile: AthleteProfile, date: string): string {
  const exported = exportGarminConnectJson(workout, profile);
  return ["Experimental: send to Garmin Connect and schedule?", `Workout: ${workout.name}`, `Sport: ${workout.sport}`, `Date: ${date}`,
    `Blocks: ${workout.steps.length} top-level`, ...exported.warnings.map((warning) => `Warning: ${warning}`),
    "Unofficial integration. This changes your Garmin account. Device sync is separate."].join("\n");
}

export async function garminOperationId(workout: Workout, profile: AthleteProfile, date: string, storage: Storage = localStorage): Promise<string> {
  const payload = JSON.stringify([date, exportGarminConnectJson(workout, profile).workout]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  const fingerprint = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const key = "local-workout-builder-garmin-operations";
  let previous: { fingerprint: string; operationId: string }[] = [];
  try {
    const parsed: unknown = JSON.parse(storage.getItem(key) ?? "[]");
    if (Array.isArray(parsed)) previous = parsed.filter((value): value is { fingerprint: string; operationId: string } =>
      typeof value === "object" && value !== null && typeof value.fingerprint === "string" && typeof value.operationId === "string");
  } catch { /* Corrupt local metadata does not bypass the bridge's durable receipts. */ }
  const existing = previous.find((item) => item.fingerprint === fingerprint);
  if (existing !== undefined) return existing.operationId;
  const operationId = crypto.randomUUID();
  storage.setItem(key, JSON.stringify([...previous.slice(-29), { fingerprint, operationId }]));
  return operationId;
}
