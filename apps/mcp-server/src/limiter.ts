import { ConnectorException } from "@serp/contracts";

/** Caps concurrent in-flight tool calls per user so one tenant cannot starve others. */
export class ConcurrencyLimiter {
  private readonly active = new Map<string, number>();

  constructor(private readonly maxPerUser: number) {}

  async run<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const current = this.active.get(userId) ?? 0;
    if (current >= this.maxPerUser) {
      throw new ConnectorException("RATE_LIMITED", "Too many requests are already running for your account; wait for earlier ones to finish.", {
        retryable: true,
        retryAfterSeconds: 2,
      });
    }
    this.active.set(userId, current + 1);
    try {
      return await fn();
    } finally {
      const left = (this.active.get(userId) ?? 1) - 1;
      if (left <= 0) this.active.delete(userId);
      else this.active.set(userId, left);
    }
  }
}
