import { AccountError } from "./accounts.js";

type Waiting = { userId: string; sessionId: string; resolve: (release: () => void) => void; reject: (error: Error) => void; cleanup: () => void };

export class InferenceQueue {
  private active = 0;
  private closed = false;
  private readonly users = new Set<string>();
  private readonly waiting: Waiting[] = [];
  constructor(private readonly valid: (sessionId: string) => boolean) {}
  acquire(userId: string, sessionId: string, signal: AbortSignal): Promise<() => void> {
    if (this.closed) return Promise.reject(new AccountError(503, "UNAVAILABLE"));
    if (signal.aborted) return Promise.reject(new AccountError(499, "REQUEST_CANCELLED"));
    if (this.users.has(userId) || (this.active >= 2 && this.waiting.length >= 5)) return Promise.reject(new AccountError(429, "INFERENCE_BUSY"));
    this.users.add(userId);
    if (this.active < 2) return Promise.resolve(this.start(userId));
    return new Promise((resolve, reject) => {
      const remove = (error: Error): void => {
        const index = this.waiting.indexOf(entry);
        if (index < 0) return;
        this.waiting.splice(index, 1);
        entry.cleanup(); this.users.delete(userId); reject(error);
      };
      const abort = (): void => remove(new AccountError(499, "REQUEST_CANCELLED"));
      const timer = setTimeout(() => remove(new AccountError(429, "INFERENCE_QUEUE_TIMEOUT")), 90_000);
      timer.unref();
      const entry: Waiting = { userId, sessionId, resolve, reject, cleanup: () => { clearTimeout(timer); signal.removeEventListener("abort", abort); } };
      this.waiting.push(entry);
      signal.addEventListener("abort", abort, { once: true });
    });
  }
  private start(userId: string): () => void {
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true; this.active -= 1; this.users.delete(userId); this.drain();
    };
  }
  private drain(): void {
    while (this.active < 2 && this.waiting.length) {
      const entry = this.waiting.shift()!;
      entry.cleanup();
      if (!this.valid(entry.sessionId)) { this.users.delete(entry.userId); entry.reject(new AccountError(401, "AUTH_REQUIRED")); }
      else entry.resolve(this.start(entry.userId));
    }
  }
  cancelSession(sessionId: string): void {
    for (let index = this.waiting.length - 1; index >= 0; index--) {
      const entry = this.waiting[index]!;
      if (entry.sessionId !== sessionId) continue;
      this.waiting.splice(index, 1); entry.cleanup(); this.users.delete(entry.userId);
      entry.reject(new AccountError(401, "AUTH_REQUIRED"));
    }
  }
  sweep(): void {
    for (const entry of [...this.waiting]) if (!this.valid(entry.sessionId)) this.cancelSession(entry.sessionId);
  }
  close(): void {
    this.closed = true;
    for (const entry of this.waiting.splice(0)) { entry.cleanup(); this.users.delete(entry.userId); entry.reject(new AccountError(503, "UNAVAILABLE")); }
  }
}
