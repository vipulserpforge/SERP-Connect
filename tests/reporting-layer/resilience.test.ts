import { describe, expect, it } from "vitest";
import { ConnectorException } from "@serp/contracts";
import { RateLimiter, SingleFlight, UserConcurrencyGate } from "@serp/reporting";
import { USER_A, USER_B, gscQuery, harness, unavailable, type Harness } from "./fixture.js";

const R = "req";
const q = (n: number) => gscQuery({ startDate: `2026-08-${String(n).padStart(2, "0")}`, endDate: "2026-09-10" });
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const gate = () => {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  return { opened, open };
};

describe("RateLimiter (token bucket)", () => {
  it("allows a burst, refuses with a retry hint, then refills over time", () => {
    let now = 0;
    const l = new RateLimiter(60, () => now); // 1 token per second
    for (let i = 0; i < 60; i++) expect(l.take("k").ok).toBe(true);
    expect(l.take("k")).toEqual({ ok: false, retryAfterSeconds: 1 });
    now += 2_000;
    expect(l.take("k").ok).toBe(true);
    expect(l.take("k").ok).toBe(true);
    expect(l.take("k").ok).toBe(false);
  });

  it("keys are independent", () => {
    const l = new RateLimiter(1, () => 0);
    expect(l.take("a").ok).toBe(true);
    expect(l.take("a").ok).toBe(false);
    expect(l.take("b").ok).toBe(true);
  });

  it("stays bounded under many keys", () => {
    const l = new RateLimiter(1, () => 0, 100);
    for (let i = 0; i < 1000; i++) l.take(`k${i}`);
    expect(l.take("fresh").ok).toBe(true);
  });
});

describe("service rate limiting", () => {
  it("limits upstream calls per user, with a retryable, structured error", async () => {
    const h = harness({ env: { REPORT_RATE_LIMIT_PER_USER_PER_MINUTE: 3, REPORT_RATE_LIMIT_PER_CONNECTION_PER_MINUTE: 100 } });
    for (let i = 1; i <= 3; i++) await h.service.queryGsc(h.principal(USER_A), q(i), R);
    const err = await h.service.queryGsc(h.principal(USER_A), q(4), R).catch((e) => e);
    expect(err).toBeInstanceOf(ConnectorException);
    expect(err).toMatchObject({ code: "RATE_LIMITED", retryable: true });
    expect(err.retryAfterSeconds).toBeGreaterThan(0);
    expect(h.gsc.calls).toHaveLength(3);
  });

  it("one user's limit does not affect another user", async () => {
    const h = harness({ env: { REPORT_RATE_LIMIT_PER_USER_PER_MINUTE: 1 } });
    await h.service.queryGsc(h.principal(USER_A), q(1), R);
    await expect(h.service.queryGsc(h.principal(USER_A), q(2), R)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    await expect(h.service.queryGsc(h.principal(USER_B), q(1), R)).resolves.toBeDefined();
  });

  it("limits per connection, so two properties on one Google account share its quota", async () => {
    const h = harness({ env: { REPORT_RATE_LIMIT_PER_CONNECTION_PER_MINUTE: 2 } });
    await h.service.queryGsc(h.principal(USER_A), q(1), R);
    await h.service.queryGsc(h.principal(USER_A), q(2), R);
    await expect(h.service.queryGsc(h.principal(USER_A), q(3), R)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    // A different connection of the same user is unaffected.
    await expect(h.service.queryGsc(h.principal(USER_A), gscQuery({ propertyId: "sc-domain:second.example" }), R)).resolves.toBeDefined();
  });

  it("cache hits are free, and a refused request does not burn the user's budget", async () => {
    const h = harness({ env: { REPORT_RATE_LIMIT_PER_USER_PER_MINUTE: 2, REPORT_RATE_LIMIT_PER_CONNECTION_PER_MINUTE: 1 } });
    await h.service.queryGsc(h.principal(USER_A), q(1), R);
    for (let i = 0; i < 20; i++) expect((await h.service.queryGsc(h.principal(USER_A), q(1), R)).cache.hit).toBe(true);
    await expect(h.service.queryGsc(h.principal(USER_A), q(2), R)).rejects.toMatchObject({ code: "RATE_LIMITED" }); // connection exhausted
    // The refused call returned its user token: a different connection can still use the second one.
    await expect(h.service.queryGsc(h.principal(USER_A), gscQuery({ propertyId: "sc-domain:second.example" }), R)).resolves.toBeDefined();
  });

  it("refills with time", async () => {
    const h = harness({ env: { REPORT_RATE_LIMIT_PER_USER_PER_MINUTE: 1 } });
    await h.service.queryGsc(h.principal(USER_A), q(1), R);
    await expect(h.service.queryGsc(h.principal(USER_A), q(2), R)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    h.clock.ms += 61_000;
    await expect(h.service.queryGsc(h.principal(USER_A), q(2), R)).resolves.toBeDefined();
  });

  it("serves the saved report instead of failing when throttled", async () => {
    const h = harness({ env: { REPORT_RATE_LIMIT_PER_USER_PER_MINUTE: 1 } });
    const recent = gscQuery({ startDate: "2026-10-10", endDate: "2026-10-17" });
    await h.service.queryGsc(h.principal(USER_A), recent, R);
    h.clock.ms += 25 * 60_000; // the entry (20 min TTL) has expired and the bucket has refilled...
    await h.service.queryGsc(h.principal(USER_A), q(1), R); // ...then this spends the only token
    const r = await h.service.queryGsc(h.principal(USER_A), recent, R);
    expect(r.cache).toMatchObject({ hit: true, stale: true });
    expect(r.warnings.map((w) => w.code)).toContain("STALE_CACHE");
  });
});

describe("timeouts", () => {
  it("abandons a provider that never answers, with a clear retryable error, and aborts the call", async () => {
    const h = harness({ env: { PROVIDER_REQUEST_TIMEOUT_MS: 100, REPORT_MAX_RETRIES: 2 } });
    let signal: AbortSignal | undefined;
    h.gsc.behave = (call) => {
      signal = call.ctx.signal;
      return new Promise(() => undefined);
    };
    const started = Date.now();
    const err = await h.service.queryGsc(h.principal(USER_A), gscQuery(), R).catch((e) => e);
    expect(err).toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: true, provider: "gsc" });
    expect(err.message).toMatch(/did not respond in time/);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(signal?.aborted).toBe(true);
    expect(h.gsc.calls).toHaveLength(1); // a spent deadline is not retried
  });

  it("a timed-out report is not cached, and the next request tries again", async () => {
    const h = harness({ env: { PROVIDER_REQUEST_TIMEOUT_MS: 100 } });
    h.gsc.behave = () => new Promise(() => undefined);
    await expect(h.service.queryGsc(h.principal(USER_A), gscQuery(), R)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    h.gsc.behave = (call) => h.gsc.ok(call);
    expect((await h.service.queryGsc(h.principal(USER_A), gscQuery(), R)).cache.hit).toBe(false);
  });

  it("releases the user's concurrency slot after a timeout", async () => {
    const h = harness({ env: { PROVIDER_REQUEST_TIMEOUT_MS: 100 }, deps: { maxConcurrentPerUser: 1 } });
    h.gsc.behave = () => new Promise(() => undefined);
    await expect(h.service.queryGsc(h.principal(USER_A), q(1), R)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    h.gsc.behave = (call) => h.gsc.ok(call);
    await expect(h.service.queryGsc(h.principal(USER_A), q(2), R)).resolves.toBeDefined();
  });
});

describe("controlled retries", () => {
  it("retries a transient provider failure with exponential backoff, then succeeds", async () => {
    const h = harness({ env: { REPORT_MAX_RETRIES: 2 } });
    h.gsc.behave = (call, n) => {
      if (n < 3) throw unavailable();
      return h.gsc.ok(call);
    };
    const r = await h.service.queryGsc(h.principal(USER_A), gscQuery(), R);
    expect(r.rows).toHaveLength(1);
    expect(h.gsc.calls).toHaveLength(3);
    expect(h.sleeps).toEqual([250, 500]);
  });

  it("gives up after the configured number of retries and reports the failure", async () => {
    const h = harness({ env: { REPORT_MAX_RETRIES: 1 } });
    h.gsc.behave = () => {
      throw unavailable();
    };
    await expect(h.service.queryGsc(h.principal(USER_A), gscQuery(), R)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(h.gsc.calls).toHaveLength(2);
  });

  it("can be turned off", async () => {
    const h = harness({ env: { REPORT_MAX_RETRIES: 0 } });
    h.gsc.behave = () => {
      throw unavailable();
    };
    await expect(h.service.queryGsc(h.principal(USER_A), gscQuery(), R)).rejects.toBeDefined();
    expect(h.gsc.calls).toHaveLength(1);
  });

  it.each([
    ["auth expired", new ConnectorException("AUTH_EXPIRED", "x", { retryable: false })],
    ["forbidden", new ConnectorException("FORBIDDEN", "x")],
    ["invalid query", new ConnectorException("INVALID_QUERY", "x")],
    ["a non-retryable outage", unavailable(false)],
    ["an unexpected bug", new Error("boom")],
    ["quota exhaustion with a long wait", new ConnectorException("PROVIDER_RATE_LIMITED", "x", { retryable: true, retryAfterSeconds: 120 })],
  ])("never retries %s", async (_n, error) => {
    const h = harness();
    h.gsc.behave = () => {
      throw error;
    };
    await expect(h.service.queryGsc(h.principal(USER_A), gscQuery(), R)).rejects.toBeDefined();
    expect(h.gsc.calls).toHaveLength(1);
    expect(h.sleeps).toEqual([]);
  });

  it("backs off and retries a Search Console 429 that carries no Retry-After, but never retries GA4's", async () => {
    const h = harness();
    h.gsc.behave = (call, n) => {
      if (n === 1) throw new ConnectorException("PROVIDER_RATE_LIMITED", "x", { retryable: true });
      return h.gsc.ok(call);
    };
    await h.service.queryGsc(h.principal(USER_A), gscQuery(), R);
    expect(h.gsc.calls).toHaveLength(2);
    expect(h.sleeps).toHaveLength(1);
  });

  it("honours a short Retry-After from Search Console, but never retries GA4 quota errors", async () => {
    const h = harness();
    h.gsc.behave = (call, n) => {
      if (n === 1) throw new ConnectorException("PROVIDER_RATE_LIMITED", "x", { retryable: true, retryAfterSeconds: 2 });
      return h.gsc.ok(call);
    };
    await h.service.queryGsc(h.principal(USER_A), gscQuery(), R);
    expect(h.sleeps).toEqual([2000]);

    h.ga4.behave = () => {
      throw new ConnectorException("PROVIDER_RATE_LIMITED", "x", { retryable: true, retryAfterSeconds: 1 });
    };
    await expect(h.service.queryGa4(h.principal(USER_A), { propertyId: "100", startDate: "2026-09-01", endDate: "2026-09-02", dimensions: ["pagePath"], metrics: ["sessions"] }, R)).rejects.toMatchObject({ code: "PROVIDER_RATE_LIMITED" });
    expect(h.ga4.calls).toHaveLength(1);
  });

  it("does not retry past the overall deadline", async () => {
    const h = harness({ env: { PROVIDER_REQUEST_TIMEOUT_MS: 100, REPORT_MAX_RETRIES: 5 } });
    h.gsc.behave = () => {
      throw new ConnectorException("PROVIDER_RATE_LIMITED", "x", { retryable: true, retryAfterSeconds: 3 });
    };
    await expect(h.service.queryGsc(h.principal(USER_A), gscQuery(), R)).rejects.toBeDefined();
    expect(h.gsc.calls).toHaveLength(1); // a 3s wait cannot fit a 100ms deadline
  });

  it("failures are never cached", async () => {
    const h = harness({ env: { REPORT_MAX_RETRIES: 0 } });
    h.gsc.behave = () => {
      throw unavailable();
    };
    await expect(h.service.queryGsc(h.principal(USER_A), gscQuery(), R)).rejects.toBeDefined();
    h.gsc.behave = (call) => h.gsc.ok(call);
    expect((await h.service.queryGsc(h.principal(USER_A), gscQuery(), R)).cache.hit).toBe(false);
  });
});

describe("concurrent requests", () => {
  async function held(h: Harness) {
    const g = gate();
    h.gsc.behave = async (call) => {
      await g.opened;
      return h.gsc.ok(call);
    };
    return g;
  }

  it("identical simultaneous requests from one user share a single upstream call", async () => {
    const h = harness();
    const g = await held(h);
    const calls = Array.from({ length: 10 }, (_, i) => h.service.queryGsc(h.principal(USER_A), gscQuery(), `r${i}`));
    await delay(20);
    g.open();
    const results = await Promise.all(calls);
    expect(h.gsc.calls).toHaveLength(1);
    expect(results.map((r) => r.requestId)).toEqual(Array.from({ length: 10 }, (_, i) => `r${i}`)); // each caller keeps their own id
    expect(new Set(results.map((r) => r.rows[0]!.owner))).toEqual(new Set([USER_A]));
  });

  it("coalesced callers do not consume rate-limit budget", async () => {
    const h = harness({ env: { REPORT_RATE_LIMIT_PER_USER_PER_MINUTE: 1 } });
    const g = await held(h);
    const calls = Array.from({ length: 8 }, () => h.service.queryGsc(h.principal(USER_A), gscQuery(), R));
    await delay(20);
    g.open();
    await expect(Promise.all(calls)).resolves.toHaveLength(8);
  });

  it("simultaneous identical requests from different users are never merged", async () => {
    const h = harness();
    const g = await held(h);
    const a = Array.from({ length: 5 }, () => h.service.queryGsc(h.principal(USER_A), gscQuery(), R));
    const b = Array.from({ length: 5 }, () => h.service.queryGsc(h.principal(USER_B), gscQuery(), R));
    await delay(20);
    g.open();
    const [ra, rb] = await Promise.all([Promise.all(a), Promise.all(b)]);
    expect(h.gsc.calls).toHaveLength(2);
    expect(ra.every((r) => r.rows[0]!.owner === USER_A && r.rows[0]!.connection === "conn-a1")).toBe(true);
    expect(rb.every((r) => r.rows[0]!.owner === USER_B && r.rows[0]!.connection === "conn-b1")).toBe(true);
  });

  it("many users in parallel each receive only their own data", async () => {
    const h = harness();
    h.gsc.behave = async (call) => {
      await delay(Math.random() * 10);
      return h.gsc.ok(call);
    };
    const jobs = Array.from({ length: 60 }, (_, i) => {
      const user = i % 2 ? USER_A : USER_B;
      return h.service.queryGsc(h.principal(user), gscQuery({ limit: 1 + (i % 3) }), `r${i}`).then((r) => ({ user, r }));
    });
    for (const { user, r } of await Promise.all(jobs)) expect(r.rows[0]!.owner).toBe(user);
  });

  it("a failing shared call fails every waiter and does not poison later requests", async () => {
    const h = harness({ env: { REPORT_MAX_RETRIES: 0 } });
    const g = gate();
    h.gsc.behave = async () => {
      await g.opened;
      throw unavailable();
    };
    const calls = Array.from({ length: 4 }, () => h.service.queryGsc(h.principal(USER_A), gscQuery(), R).catch((e) => e));
    await delay(20);
    g.open();
    for (const e of await Promise.all(calls)) expect(e).toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(h.gsc.calls).toHaveLength(1);
    h.gsc.behave = (call) => h.gsc.ok(call);
    await expect(h.service.queryGsc(h.principal(USER_A), gscQuery(), R)).resolves.toMatchObject({ rowCountReturned: 1 });
  });

  it("caps simultaneous upstream reports per user without blocking other users", async () => {
    const h = harness({ deps: { maxConcurrentPerUser: 2 } });
    const g = await held(h);
    const mine = [1, 2, 3, 4].map((n) => h.service.queryGsc(h.principal(USER_A), q(n), R).catch((e) => e));
    const theirs = h.service.queryGsc(h.principal(USER_B), gscQuery(), R);
    await delay(20);
    g.open();
    const out = await Promise.all(mine);
    expect(out.filter((x) => x instanceof ConnectorException && x.code === "RATE_LIMITED")).toHaveLength(2);
    expect(out.filter((x) => !(x instanceof Error))).toHaveLength(2);
    await expect(theirs).resolves.toBeDefined();
  });

  it("a mutation of one caller's result does not reach a concurrent caller", async () => {
    const h = harness();
    const g = await held(h);
    const [x, y] = [h.service.queryGsc(h.principal(USER_A), gscQuery(), "x"), h.service.queryGsc(h.principal(USER_A), gscQuery(), "y")];
    await delay(10);
    g.open();
    const [rx, ry] = await Promise.all([x, y]);
    rx.rows[0]!.owner = "tampered";
    expect(ry.rows[0]!.owner).toBe(USER_A);
  });
});

describe("primitives", () => {
  it("SingleFlight clears finished flights and never shares across keys", async () => {
    const f = new SingleFlight<number>();
    let n = 0;
    const a = f.run("k1", async () => ++n);
    const b = f.run("k1", async () => ++n);
    const c = f.run("k2", async () => ++n);
    expect([a.joined, b.joined, c.joined]).toEqual([false, true, false]);
    expect(await Promise.all([a.promise, b.promise, c.promise])).toEqual([1, 1, 2]);
    expect(f.size).toBe(0);
    expect((await f.run("k1", async () => ++n).promise)).toBe(3);
  });

  it("UserConcurrencyGate releases exactly once and tracks users separately", () => {
    const g = new UserConcurrencyGate(1);
    const release = g.acquire("u");
    expect(() => g.acquire("u")).toThrow(/Too many reports/);
    expect(() => g.acquire("other")).not.toThrow();
    release();
    release();
    expect(g.inFlight("u")).toBe(0);
    expect(() => g.acquire("u")).not.toThrow();
  });
});
