import { describe, expect, it } from "vitest";
import { InferenceQueue } from "../src/shared/inferenceQueue.js";

describe("hosted inference queue", () => {
  it("keeps two active, permits five waiting, and rejects duplicate users and overload", async () => {
    const queue = new InferenceQueue(() => true), signal = new AbortController().signal;
    const first = await queue.acquire("a", "a", signal), second = await queue.acquire("b", "b", signal);
    await expect(queue.acquire("a", "a", signal)).rejects.toThrow("INFERENCE_BUSY");
    const waiting = ["c", "d", "e", "f", "g"].map(id => queue.acquire(id, id, signal));
    await expect(queue.acquire("h", "h", signal)).rejects.toThrow("INFERENCE_BUSY");
    first(); (await waiting[0]!)(); second();
    for (const item of waiting.slice(1)) (await item)();
    queue.close();
  });
  it("cancels disconnected and revoked sessions and skips expired queued work", async () => {
    const valid = new Set(["a", "b", "c", "d", "e"]);
    const queue = new InferenceQueue(id => valid.has(id));
    const abort = new AbortController(), signal = new AbortController().signal;
    const first = await queue.acquire("a", "a", signal), second = await queue.acquire("b", "b", signal);
    const disconnected = expect(queue.acquire("c", "c", abort.signal)).rejects.toThrow("REQUEST_CANCELLED");
    abort.abort(); await disconnected;
    const revoked = expect(queue.acquire("d", "d", signal)).rejects.toThrow("AUTH_REQUIRED");
    queue.cancelSession("d"); await revoked;
    const expired = expect(queue.acquire("e", "e", signal)).rejects.toThrow("AUTH_REQUIRED");
    valid.delete("e"); first(); await expired;
    second(); queue.close();
  });
});
