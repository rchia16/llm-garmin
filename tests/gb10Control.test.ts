import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { handleGb10Start, handleGb10Status, probeGb10Health, startGb10Server } from "../src/local/gb10Control.js";

describe("local GB10 control", () => {
  it("uses only the fixed service, host, port and noninteractive SSH key", async () => {
    let command: { file: string; args: string[] } | undefined;
    await startGb10Server(async (file, args) => { command = { file, args }; }, () => true);
    expect(command?.file).toBe("ssh");
    expect(command?.args).toContain("BatchMode=yes");
    expect(command?.args).toContain("StrictHostKeyChecking=yes");
    expect(command?.args).toContain("rchia@100.76.243.123");
    expect(command?.args.at(-1)).toBe("systemctl --user daemon-reload && systemctl --user enable --now llm-garmin.service && tailscale serve --bg --https=8443 localhost:8081");
    await expect(startGb10Server(async () => { throw new Error("should not run"); }, () => false)).rejects.toThrow("SSH_KEY_MISSING");
  });

  it("rejects cross-origin and unauthenticated local POSTs", async () => {
    let calls = 0;
    const server = createServer((request, response) => {
      if (request.url === "/status") void handleGb10Status(request, response, async () => "ready");
      else void handleGb10Start(request, response, async () => { calls += 1; });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address() as AddressInfo;
      const origin = `http://127.0.0.1:${address.port}`;
      const request = (headers: Record<string, string>) => fetch(origin, { method: "POST", headers });
      expect((await request({ Origin: "https://malicious.example", "X-LLM-Garmin-Control": "start" })).status).toBe(403);
      expect((await request({ Origin: origin })).status).toBe(403);
      expect(calls).toBe(0);
      const response = await request({ Origin: origin, "X-LLM-Garmin-Control": "start" });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true });
      expect(calls).toBe(1);
      const status = await fetch(`${origin}/status`, { method: "POST", headers: { Origin: origin, "X-LLM-Garmin-Control": "status" } });
      expect(await status.json()).toMatchObject({ ok: true, state: "ready" });
      expect(calls).toBe(1);
      expect((await fetch(`${origin}/status`, { method: "POST", headers: { Origin: "https://malicious.example", "X-LLM-Garmin-Control": "status" } })).status).toBe(403);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    }
  });

  it("checks only the fixed GB10 health URL and distinguishes loading from offline", async () => {
    const statuses = [200, 503, 502, 504, 500];
    const expected = ["ready", "loading", "offline", "offline", "unknown"];
    for (const [index, status] of statuses.entries()) {
      const state = await probeGb10Health(async (url) => {
        expect(url).toBe("https://promaxgb10-4e2b.tail06a565.ts.net:8443/health");
        return new Response("", { status });
      });
      expect(state).toBe(expected[index]);
    }
    expect(await probeGb10Health(async () => { throw new Error("unreachable"); })).toBe("offline");
  });
});
