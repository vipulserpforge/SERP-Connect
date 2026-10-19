import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });

// Files git would commit: tracked plus untracked-but-not-ignored.
const files = [...git("ls-files").split("\n"), ...git("ls-files", "--others", "--exclude-standard").split("\n")]
  .filter(Boolean)
  .filter((f) => !f.endsWith("pnpm-lock.yaml"));

// Patterns are assembled from fragments so this file does not match itself.
const PATTERNS: Array<[string, RegExp]> = [
  ["Google access token", new RegExp(["ya29", "\\.[A-Za-z0-9_-]{20,}"].join(""))],
  ["Google refresh token", new RegExp(["\\b1/", "/0[A-Za-z0-9_-]{30,}"].join(""))],
  ["Google client secret", new RegExp(["GOCSPX", "-[A-Za-z0-9_-]{20,}"].join(""))],
  ["private key block", new RegExp(["-----BEGIN [A-Z ]*PRIV", "ATE KEY-----"].join(""))],
  ["JWT", /\beyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["database URL with password", /postgres(?:ql)?:\/\/[^:\s/@]+:(?!password|\[|\$|<|your|xxx|%)[^@\s]{6,}@/i],
];

describe("repository hygiene", () => {
  it("contains no credential-shaped strings in committable files", () => {
    const hits: string[] = [];
    for (const f of files) {
      let text: string;
      try {
        if (statSync(`${root}/${f}`).size > 2_000_000) continue;
        text = readFileSync(`${root}/${f}`, "utf8");
      } catch {
        continue;
      }
      for (const [name, re] of PATTERNS) if (re.test(text)) hits.push(`${f}: ${name}`);
    }
    expect(hits).toEqual([]);
  });

  it("never commits .env files other than the example", () => {
    const env = files.filter((f) => /(^|\/)\.env/.test(f));
    expect(env).toEqual([".env.example"]);
  });

  it("git ignores real env files", () => {
    for (const f of [".env", ".env.local", ".env.production", "apps/web/.env.local"]) {
      expect(() => git("check-ignore", "-q", f), f).not.toThrow();
    }
  });

  it("no secret-bearing variable is exposed to the browser via NEXT_PUBLIC_", () => {
    const names = new Set<string>();
    for (const f of files.filter((x) => /\.(ts|tsx|mts|js|mjs|md|example|yml|toml)$/.test(x) || x.endsWith(".env.example"))) {
      let text = "";
      try {
        text = readFileSync(`${root}/${f}`, "utf8");
      } catch {
        continue;
      }
      for (const m of text.matchAll(/NEXT_PUBLIC_[A-Z0-9_]+/g)) names.add(m[0]);
    }
    for (const n of names) expect(n, n).not.toMatch(/SECRET|SERVICE|PRIVATE|PASSWORD|DB_URL|KEYS|CLIENT_SECRET/);
  });

  it("server-only packages are not imported from client components", () => {
    const clientFiles = files.filter((f) => f.startsWith("apps/web/src/") && /\.tsx?$/.test(f)).filter((f) => /^\s*["']use client["']/.test(readFileSync(`${root}/${f}`, "utf8")));
    for (const f of clientFiles) {
      expect(readFileSync(`${root}/${f}`, "utf8"), f).not.toMatch(/@serp\/(secrets|credentials|db)|lib\/server["']/);
    }
  });
});
