import { rootCertificates } from "node:tls";
import { describe, expect, it } from "vitest";
import { poolSizeFor, sslOptionsFor } from "../../packages/db/src/pg.js";
import { SUPABASE_ROOT_CA } from "../../packages/db/src/supabase-ca.js";

describe("database TLS", () => {
  it("uses no TLS for localhost only", () => {
    for (const h of ["localhost", "127.0.0.1", "::1"]) expect(sslOptionsFor(h, {})).toBeUndefined();
    expect(sslOptionsFor("localhost.evil.example", {})).toBeDefined();
  });

  it("verifies remote servers against Node's roots plus the Supabase CA", () => {
    const ssl = sslOptionsFor("aws-0-ap-southeast-1.pooler.supabase.com", {})!;
    expect(ssl.rejectUnauthorized).toBe(true);
    expect(ssl.ca).toContain(SUPABASE_ROOT_CA);
    expect(ssl.ca).toEqual(expect.arrayContaining([rootCertificates[0]]));
  });

  it("the bundled CA is a real certificate", () => {
    expect(SUPABASE_ROOT_CA).toMatch(/^-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=\n]+-----END CERTIFICATE-----\n$/);
  });

  it("SUPABASE_DB_CA replaces the bundled CA, accepting escaped line breaks", () => {
    const ssl = sslOptionsFor("db.example.com", { SUPABASE_DB_CA: "-----BEGIN CERTIFICATE-----\\nABC\\n-----END CERTIFICATE-----" })!;
    expect(ssl.ca).toContain("-----BEGIN CERTIFICATE-----\nABC\n-----END CERTIFICATE-----");
    expect(ssl.ca).not.toContain(SUPABASE_ROOT_CA);
  });

  it("verification cannot be switched off by a setting", () => {
    for (const v of ["false", "FALSE", "0", "", "true", undefined]) expect(sslOptionsFor("db.example.com", { SUPABASE_DB_SSL_VERIFY: v })!.rejectUnauthorized).toBe(true);
  });
});

describe("pool size", () => {
  it("is small on Vercel, larger on a long-running server, and configurable", () => {
    expect(poolSizeFor({})).toBe(5);
    expect(poolSizeFor({ VERCEL: "1" })).toBe(2);
    expect(poolSizeFor({ VERCEL: "1", DB_POOL_MAX: "4" })).toBe(4);
    expect(poolSizeFor({ DB_POOL_MAX: "0" })).toBe(5);
    expect(poolSizeFor({ DB_POOL_MAX: "999" })).toBe(5);
    expect(poolSizeFor({ DB_POOL_MAX: "abc" })).toBe(5);
  });
});
