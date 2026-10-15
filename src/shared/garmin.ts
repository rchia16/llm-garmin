import { join } from "node:path";
import { createGarminAuth } from "../local/garminAuth.js";
import { createGarminRunner, garminLoginSchema, garminMfaSchema, prepareGarminSend, type GarminAction, type GarminRunner } from "../local/garminControl.js";
import { garminResultSchema, type GarminResult } from "../local/garminProtocol.js";
import type { Session } from "./accounts.js";

export type GarminConnection = { run: GarminRunner; auth: ReturnType<typeof createGarminAuth> };
type ConnectionState = GarminConnection & { busy: boolean; owner: string | undefined; ownerExpires: number; touched: number };

/** The browser cannot choose the filesystem directory or another session's MFA process. */
export class UserGarmin {
  private readonly users = new Map<string, ConnectionState>();
  constructor(private readonly dataDirectory: string,
    private readonly factory: (directory: string) => GarminConnection = directory => ({ run: createGarminRunner(directory), auth: createGarminAuth(directory) })) {}

  async execute(session: Session, action: GarminAction, input?: unknown): Promise<GarminResult> {
    let state = this.users.get(session.user.id);
    if (!state) {
      if (!/^[a-f0-9-]{36}$/.test(session.user.id)) throw new Error("Invalid internal user ID.");
      state = { ...this.factory(join(this.dataDirectory, "garmin", session.user.id)), busy: false, owner: undefined, ownerExpires: 0, touched: Date.now() };
      this.users.set(session.user.id, state);
    }
    state.touched = Date.now();
    if (state.owner && Date.now() >= state.ownerExpires) {
      state.owner = undefined;
      await state.auth("cancel");
    }
    if (action === "cancel") {
      if (state.owner !== session.id) return { ok: false, code: "AUTH_REQUIRED" };
      state.owner = undefined;
      return state.auth("cancel");
    }
    if (state.owner && state.owner !== session.id) return { ok: false, code: "BUSY" };
    if (state.owner && action === "login") return { ok: false, code: "BUSY" };
    if (action === "mfa" && state.owner !== session.id) return { ok: false, code: "AUTH_REQUIRED" };
    if (state.busy) return { ok: false, code: "BUSY" };
    if (state.owner && action !== "mfa" && action !== "login") return { ok: false, code: "BUSY" };
    const data = action === "login" ? garminLoginSchema.parse(input)
      : action === "mfa" ? garminMfaSchema.parse(input)
      : action === "send" ? prepareGarminSend(input) : undefined;
    state.busy = true;
    if (action === "login") { state.owner = session.id; state.ownerExpires = Date.now() + 180_000; }
    try {
      const result = garminResultSchema.parse(await (["login", "mfa"].includes(action)
        ? state.auth(action, data) : state.run(action as "status" | "send" | "logout", data)));
      if (action === "login" || action === "mfa") {
        state.owner = result.code === "MFA_REQUIRED" ? session.id : undefined;
      }
      return result;
    } finally { state.busy = false; }
  }
  cancelSession(sessionId: string): void {
    for (const state of this.users.values()) if (state.owner === sessionId) {
      state.owner = undefined;
      void state.auth("cancel");
    }
  }
  sweep(validSession: (id: string) => boolean): void {
    for (const [id, state] of this.users) {
      if (state.owner && (!validSession(state.owner) || Date.now() >= state.ownerExpires)) {
        state.owner = undefined;
        void state.auth("cancel");
      }
      if (!state.owner && !state.busy && Date.now() - state.touched > 180_000) this.users.delete(id);
    }
  }
  close(): void {
    for (const state of this.users.values()) void state.auth("cancel");
    this.users.clear();
  }
}
