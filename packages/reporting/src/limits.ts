import { ConnectorException } from "@serp/contracts";

/**
 * Token bucket: `perMinute` tokens, refilled continuously. Only upstream provider calls take tokens, so cache hits
 * are free. Keyed (per user, per connection); idle keys are dropped so the map stays bounded.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 10_000,
  ) {}

  /** Takes one token, or returns how many seconds until one is available. */
  take(key: string): { ok: true } | { ok: false; retryAfterSeconds: number } {
    const t = this.now();
    const b = this.refill(key, t);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { ok: true };
    }
    const secondsPerToken = 60 / this.perMinute;
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((1 - b.tokens) * secondsPerToken)) };
  }

  refund(key: string): void {
    const b = this.buckets.get(key);
    if (b) b.tokens = Math.min(this.perMinute, b.tokens + 1);
  }

  private refill(key: string, t: number) {
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) this.prune(t);
      b = { tokens: this.perMinute, at: t };
      this.buckets.set(key, b);
      return b;
    }
    b.tokens = Math.min(this.perMinute, b.tokens + ((t - b.at) / 60_000) * this.perMinute);
    b.at = t;
    return b;
  }

  private prune(t: number): void {
    for (const [k, b] of this.buckets) {
      if (b.tokens + ((t - b.at) / 60_000) * this.perMinute >= this.perMinute) this.buckets.delete(k);
    }
    if (this.buckets.size >= this.maxKeys) this.buckets.delete(this.buckets.keys().next().value as string);
  }
}

/** Caps simultaneous upstream reports per user so one account cannot occupy every provider slot. Never queues: it rejects. */
export class UserConcurrencyGate {
  private readonly active = new Map<string, number>();
  constructor(private readonly max: number) {}

  acquire(userId: string): () => void {
    const n = this.active.get(userId) ?? 0;
    if (n >= this.max) {
      throw new ConnectorException("RATE_LIMITED", "Too many reports are already running for your account.", {
        retryable: true,
        retryAfterSeconds: 2,
        suggestedAction: "Wait for a running report to finish, then try again.",
      });
    }
    this.active.set(userId, n + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.active.get(userId) ?? 1) - 1;
      if (left <= 0) this.active.delete(userId);
      else this.active.set(userId, left);
    };
  }

  inFlight(userId: string): number {
    return this.active.get(userId) ?? 0;
  }
}

/**
 * Coalesces identical in-flight work. The caller supplies a key that already contains the full scope
 * (user, provider, connection, property, query hash), so two tenants can never share a flight.
 */
export class SingleFlight<T> {
  private readonly flights = new Map<string, Promise<T>>();

  run(key: string, work: () => Promise<T>): { promise: Promise<T>; joined: boolean } {
    const existing = this.flights.get(key);
    if (existing) return { promise: existing, joined: true };
    const promise = work().finally(() => {
      if (this.flights.get(key) === promise) this.flights.delete(key);
    });
    this.flights.set(key, promise);
    return { promise, joined: false };
  }

  get size(): number {
    return this.flights.size;
  }
}
