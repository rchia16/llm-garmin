import { stdin, stdout } from "node:process";
import { join } from "node:path";
import { AccountStore, usernameSchema } from "./accounts.js";
import { hostedDataDirectory } from "./config.js";

async function hiddenPassword(prompt: string): Promise<string> {
  if (!stdin.isTTY) throw new Error("Run this command in an interactive terminal; passwords cannot be command arguments.");
  stdin.setRawMode(true); stdin.resume();
  stdout.write(prompt);
  return new Promise((resolve, reject) => {
    let password = "";
    const finish = (error?: Error): void => {
      stdin.off("data", data); stdin.setRawMode(false); stdin.pause(); stdout.write("\n");
      if (error) reject(error); else resolve(password);
    };
    const data = (chunk: Buffer): void => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003") { finish(new Error("Cancelled.")); return; }
        if (character === "\r" || character === "\n") { finish(); return; }
        if (character === "\u007f" || character === "\b") password = password.slice(0, -1);
        else if (character >= " " && password.length < 1024) password += character;
      }
    };
    stdin.on("data", data);
  });
}

async function main(): Promise<void> {
  const [action, username, ...extra] = process.argv.slice(2);
  if (!username || extra.length || !["create", "reset", "disable"].includes(action ?? "")) {
    throw new Error("Usage: npm run account -- create|reset|disable USERNAME");
  }
  usernameSchema.parse(username);
  const store = new AccountStore(join(hostedDataDirectory(), "accounts.sqlite"));
  try {
    if (action === "disable") store.disable(username);
    else {
      const password = await hiddenPassword("Temporary password (12+ characters, hidden): ");
      const confirmation = await hiddenPassword("Confirm password (hidden): ");
      if (password !== confirmation) throw new Error("Passwords do not match.");
      if (action === "create") await store.createUser(username, password);
      else await store.resetPassword(username, password);
    }
    stdout.write(`Account ${action} completed.\n`);
  } finally { store.close(); }
}
void main().catch(error => {
  // Validation/database errors must never echo password inputs.
  console.error(error instanceof Error && !("issues" in error) ? error.message : "Invalid account details.");
  process.exitCode = 1;
});
