import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const bash = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "/bin/bash";
const setupPs = readFileSync("Setup Garmin Python.ps1", "utf8");
const setupSh = readFileSync("scripts/setup-garmin-python.sh", "utf8");

describe("Python installation guidance (no installs or network)", () => {
  it.skipIf(process.platform !== "win32").each([false, true])("Windows preserves existing environment=%s and shows the official link", (existing) => {
    const directory = mkdtempSync(join(tmpdir(), "workout-python-guidance-"));
    try {
      if (existing) mkdirSync(join(directory, ".venv"));
      // Fake interpreter discovery only. Execute the real setup failure paths
      // against disposable storage, never the user's environment.
      const script = setupPs.replace(/^\$projectDirectory = .+$/m, `$projectDirectory = '${directory.replaceAll("'", "''")}'`)
        .replace("$ErrorActionPreference = 'Stop'", "$ErrorActionPreference = 'Stop'\nfunction Get-Command { return $null }");
      const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$code = [Console]::In.ReadToEnd(); & ([ScriptBlock]::Create($code))"], { input: script, encoding: "utf8", timeout: 15_000 });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("Python 3.13 is recommended");
      expect(result.stdout).toContain("https://www.python.org/downloads/windows/");
      expect(result.stdout).toContain("reopen your terminal");
      expect(existsSync(join(directory, ".venv"))).toBe(existing);
      if (existing) expect(result.stdout).toContain("not overwritten");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it.skipIf(!existsSync(bash)).each(["Linux", "Darwin", "MINGW64_NT"])("Bash chooses the right download link on %s", (platform) => {
    const directory = mkdtempSync(join(tmpdir(), "workout-python-guidance-"));
    try {
      // Windows temp paths converted for Git Bash; no interpreter is invoked.
      const portable = directory.replaceAll("\\", "/");
      const script = setupSh.replace(/^project_directory=.+$/m, `project_directory='${portable}'`)
        .replace("set -euo pipefail", `set -euo pipefail\nuname() { echo '${platform}'; }\ncommand() { return 1; }`);
      const result = spawnSync(bash, ["-s"], { input: script, encoding: "utf8", timeout: 15_000 });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Python 3.13 is recommended");
      expect(result.stderr).toContain(platform.startsWith("MINGW") ? "Download: https://www.python.org/downloads/windows/" : "Download: https://www.python.org/downloads/\n");
      expect(result.stderr).toContain("reopen your terminal");
      expect(existsSync(join(directory, ".venv"))).toBe(false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
