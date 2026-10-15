import { requestGarmin } from "./garminClient.js";
import { garminResultMessage, type GarminResult } from "../local/garminProtocol.js";
import { hostedEpoch, isHosted } from "./hostedClient.js";

export function showGarminLogin(onResult: (result: GarminResult) => void): void {
  const before = hostedEpoch();
  const dialog = document.createElement("dialog");
  dialog.className = "garmin-login";
  dialog.setAttribute("aria-labelledby", "garmin-login-title");
  dialog.innerHTML = `<h2 id="garmin-login-title">Connect Garmin</h2>
    <p>Experimental integration. Your password is used only to sign in, not saved. ${isHosted() ? "Your Garmin session is stored privately for your app account on GB10." : "The session is stored privately on this computer."}</p>
    <form><div class="garmin-credentials">
      <label class="field-label" for="garmin-email">Garmin email</label>
      <input id="garmin-email" name="email" type="email" autocomplete="username" required maxlength="254" />
      <label class="field-label" for="garmin-password">Password</label>
      <input id="garmin-password" name="password" type="password" autocomplete="current-password" required maxlength="1024" />
    </div><div class="garmin-mfa" hidden>
      <label class="field-label" for="garmin-code">Verification code</label>
      <input id="garmin-code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{4,10}" maxlength="10" />
    </div><p class="save-note" role="status" aria-live="polite"></p>
    <button class="save-button" type="submit">Sign in</button>
    <button class="save-button" type="button" data-cancel>Cancel</button></form>`;
  document.body.append(dialog);
  const form = dialog.querySelector<HTMLFormElement>("form")!;
  const email = dialog.querySelector<HTMLInputElement>("#garmin-email")!;
  const password = dialog.querySelector<HTMLInputElement>("#garmin-password")!;
  const code = dialog.querySelector<HTMLInputElement>("#garmin-code")!;
  const submit = dialog.querySelector<HTMLButtonElement>('[type="submit"]')!;
  const status = dialog.querySelector<HTMLElement>('[role="status"]')!;
  let mfa = false;
  let busy = false;
  let closed = false;
  const cancel = (): void => {
    if (closed || before !== hostedEpoch()) return;
    closed = true;
    password.value = ""; code.value = ""; email.value = "";
    dialog.close(); dialog.remove();
    void requestGarmin("cancel");
  };
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); cancel(); });
  dialog.querySelector("[data-cancel]")!.addEventListener("click", cancel);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy || before !== hostedEpoch()) return;
    busy = true; submit.disabled = true;
    status.textContent = "Signing in…";
    const request = mfa ? requestGarmin("mfa", { code: code.value }) : requestGarmin("login", { email: email.value.trim(), password: password.value });
    password.value = ""; code.value = "";
    const result = await request;
    if (closed || before !== hostedEpoch()) return;
    busy = false; submit.disabled = false;
    status.textContent = garminResultMessage(result);
    if (result.code === "MFA_REQUIRED") {
      mfa = true;
      email.disabled = true; password.disabled = true;
      dialog.querySelector<HTMLElement>(".garmin-credentials")!.hidden = true;
      dialog.querySelector<HTMLElement>(".garmin-mfa")!.hidden = false;
      code.required = true; submit.textContent = "Verify code"; code.focus();
    } else if (result.ok) {
      closed = true; dialog.close(); dialog.remove(); onResult(result);
    } else {
      mfa = false; email.disabled = false; password.disabled = false; code.required = false;
      dialog.querySelector<HTMLElement>(".garmin-credentials")!.hidden = false;
      dialog.querySelector<HTMLElement>(".garmin-mfa")!.hidden = true;
      submit.textContent = "Sign in"; password.focus();
    }
  });
  dialog.showModal(); email.focus();
}
