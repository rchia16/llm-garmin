import type { Account } from "../shared/accounts.js";
import { z } from "zod";

type LoginState = { user: Account; csrfToken: string };
const loginStateSchema = z.object({ user: z.object({ id: z.string().uuid(), username: z.string(), mustChangePassword: z.boolean() }), csrfToken: z.string().regex(/^[a-f0-9]{64}$/) });
let session: LoginState | undefined;
let epoch = 0;
let requests = new AbortController();
let changingPassword = false;
let message = "";

export function isHosted(): boolean {
  return typeof window !== "undefined" && ((window as Window & { __WORKOUT_BUILDER_SHARED__?: boolean }).__WORKOUT_BUILDER_SHARED__ === true
    || !["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname));
}
export const getHostedSession = (): LoginState | undefined => session;
export const hostedEpoch = (): number => epoch;
export const accountGateNeeded = (): boolean => !session || session.user.mustChangePassword || changingPassword;
export const userStorageKey = (key: string): string => `local-workout-builder:user:${session?.user.id ?? "guest"}:${key}`;

function clearSession(): void {
  epoch++; requests.abort(); requests = new AbortController(); session = undefined; changingPassword = false;
  document.querySelectorAll("dialog").forEach(dialog => dialog.remove());
  window.dispatchEvent(new Event("workout-account-changed"));
}

export const hostedFetch: typeof fetch = async (input, init) => {
  const before = epoch;
  const headers = new Headers(init?.headers);
  if (session) headers.set("X-CSRF-Token", session.csrfToken);
  const response = await fetch(input, { ...init, headers, credentials: "same-origin",
    signal: init?.signal ? AbortSignal.any([requests.signal, init.signal]) : requests.signal });
  if (before !== epoch) throw new Error("Account changed; previous response discarded.");
  const responseUser = response.headers.get("X-Workout-User");
  if (session && responseUser && responseUser !== session.user.id) {
    message = "The signed-in account changed in another tab. Sign in again.";
    clearSession(); throw new Error("Account changed.");
  }
  if (response.status === 401 && !String(input).endsWith("/auth/login")) {
    if (session) message = "Your session expired. Sign in again.";
    clearSession();
    throw new Error("Sign in again.");
  }
  return response;
};

/** Retries from an old interpretation must never adopt a new account's cookie/CSRF. */
export function accountFetch(): typeof fetch {
  const before = epoch;
  return async (input, init) => {
    if (before !== epoch) throw new DOMException("Account changed.", "AbortError");
    return hostedFetch(input, init);
  };
}

export async function hostedRequest<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const before = epoch;
  const response = await hostedFetch(path, { method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    if (response.status === 409) throw new Error("This item changed on another device. Reload the saved version before saving again; your draft is kept.");
    if (response.status === 429) throw new Error("Too many requests. Wait a minute and retry.");
    const data = await response.json() as { error?: string };
    throw new Error(data.error === "INVALID_CREDENTIALS" ? "Username or password is incorrect." : data.error === "PASSWORD_INCORRECT" ? "Current password is incorrect." : data.error === "PASSWORD_UNCHANGED" ? "Choose a password different from your current password." : "Request failed. Check your input and retry.");
  }
  const data = await response.json() as T;
  if (before !== epoch) throw new Error("Account changed; previous response discarded.");
  return data;
}

export async function restoreHostedSession(): Promise<boolean> {
  try { session = loginStateSchema.parse(await hostedRequest<unknown>("/api/auth/session")); return true; }
  catch { return false; }
}
export async function signOut(): Promise<void> {
  // Only clear after server revocation succeeds; otherwise a reload could resurrect the session.
  await hostedRequest("/api/auth/logout", "POST");
  message = "Signed out."; clearSession();
}
export function requestPasswordChange(): void { changingPassword = true; }

export function renderAccountGate(root: HTMLElement, ready: () => Promise<void>): void {
  const passwordChange = !!session;
  if (root.querySelector(`[data-account-mode="${passwordChange ? "password" : "login"}"]`)) return;
  root.innerHTML = `<main class="account-panel"><h1>${passwordChange ? "Change password" : "Sign in to Workout Builder"}</h1>
    <p>${passwordChange ? "Use a new app password with at least 12 characters. You will sign in again afterward." : "Use the app account created by your administrator. Connect Garmin separately after signing in."}</p>
    <form id="account-form" data-account-mode="${passwordChange ? "password" : "login"}">
      ${passwordChange ? "" : '<label>Username<input name="username" autocomplete="username" required maxlength="80" /></label>'}
      <label>${passwordChange ? "Current password" : "Password"}<input name="password" type="password" autocomplete="current-password" required maxlength="1024" /></label>
      ${passwordChange ? '<label>New password<input name="new-password" type="password" autocomplete="new-password" required minlength="12" maxlength="1024" /></label><label>Confirm new password<input name="confirm-password" type="password" autocomplete="new-password" required minlength="12" maxlength="1024" /></label>' : ""}
      <p role="status" aria-live="polite"></p><button class="primary-button" type="submit">${passwordChange ? "Change password" : "Sign in"}</button>
      ${passwordChange && !session?.user.mustChangePassword ? '<button type="button" data-account-back>Back</button>' : ""}
      ${passwordChange ? '<button type="button" data-account-signout>Sign out</button>' : ""}
    </form><p>Accounts and password resets are managed by the administrator.</p></main>`;
  const status = root.querySelector<HTMLElement>('[role="status"]')!;
  status.textContent = message;
  root.querySelector("[data-account-back]")?.addEventListener("click", () => { changingPassword = false; void ready(); });
  root.querySelector("[data-account-signout]")?.addEventListener("click", () => { void signOut().catch(error => { status.textContent = String(error); }); });
  root.querySelector<HTMLFormElement>("form")!.addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const fields = new FormData(form);
    const password = String(fields.get("password") ?? "");
    const nextPassword = String(fields.get("new-password") ?? "");
    form.querySelectorAll<HTMLInputElement>('input[type="password"]').forEach(input => { input.value = ""; });
    const button = form.querySelector<HTMLButtonElement>('[type="submit"]')!;
    button.disabled = true; status.textContent = "Please wait…";
    try {
      if (passwordChange) {
        if (nextPassword !== fields.get("confirm-password")) throw new Error("New passwords do not match.");
        await hostedRequest("/api/auth/password", "POST", { currentPassword: password, password: nextPassword });
        message = "Password changed. Sign in with your new password."; clearSession();
      } else {
        const login = loginStateSchema.parse(await hostedRequest<unknown>("/api/auth/login", "POST", { username: String(fields.get("username") ?? ""), password }));
        epoch++; requests.abort(); requests = new AbortController(); session = login; message = "";
        await ready();
      }
    } catch (error) { status.textContent = error instanceof Error ? error.message : "Sign-in failed."; }
    finally { button.disabled = false; }
  });
}
