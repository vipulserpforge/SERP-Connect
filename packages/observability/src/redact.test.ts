import { describe, expect, it } from "vitest";
import { createLogger, redact } from "./index.js";

describe("redact", () => {
  it("masks sensitive keys and token shapes", () => {
    const out = redact({
      access_token: "ya29.abc",
      nested: { Authorization: "Bearer abc.def", note: "ok", refreshToken: "r" },
      msg: "header was Bearer zzz.yyy end",
      email: "a@b.com",
    }) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toMatch(/ya29|abc\.def|zzz\.yyy|a@b\.com/);
    expect((out.nested as Record<string, unknown>).note).toBe("ok");
  });

  it("masks credential-shaped strings and OAuth/crypto field names", () => {
    const refresh = ["1/", "/", "a".repeat(40)].join("");
    const dbUrl = ["postgres:/", "/user:hunter2pass@db.example.com:5432/postgres"].join("");
    const jwt = ["eyJhbGciOiJSUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "c2ln"].join(".");
    const out = JSON.stringify(
      redact({
        msg: `refresh ${refresh} and ${jwt} at ${dbUrl}`,
        code_verifier: "v-verifier-value",
        state: "state-value-xyz",
        ciphertext: "cipher-value",
        wrappedDek: "wrapped-value",
        authErrorCode: "invalid_credentials",
      }),
    );
    for (const leaked of [refresh, jwt, "hunter2pass", "v-verifier-value", "state-value-xyz", "cipher-value", "wrapped-value"]) {
      expect(out).not.toContain(leaked);
    }
    expect(out).toContain("invalid_credentials");
  });

  it("logger output is redacted", () => {
    const lines: string[] = [];
    createLogger({ write: (l) => lines.push(l) }).info("x", { token: "secret-value", ok: 1 });
    expect(lines[0]).not.toContain("secret-value");
    expect(lines[0]).toContain('"ok":1');
  });

  it("redacts credentials inside URLs and query strings in plain text", () => {
    const apiKey = "0123456789abcdef0123456789abcdef";
    const msg = `request failed: https://ssl.bing.com/webmaster/api.svc/json/GetUserSites?siteUrl=https%3A%2F%2Fa.com&apikey=${apiKey}&x=1`;
    const out = JSON.stringify(redact({ message: msg, other: "access_token=abc123 and code=zzz789" }));
    expect(out).not.toContain(apiKey);
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("zzz789");
    expect(out).toContain("siteUrl=https%3A%2F%2Fa.com"); // non-secret parts stay readable
    expect(out).toContain("&x=1");
  });
});
