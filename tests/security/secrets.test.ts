import { describe, expect, it } from "vitest";
import {
  KeyRingProvider,
  KmsKeyProvider,
  LocalKeyProvider,
  createKeyProviderFromEnv,
  decryptSecret,
  encryptSecret,
  generateLocalMasterKey,
  parseKeyRing,
  rewrapSecret,
  type KmsClient,
} from "@serp/secrets";

const k = () => generateLocalMasterKey();

describe("envelope encryption", () => {
  it("round-trips, never stores plaintext, and uses a fresh data key and nonce each time", async () => {
    const keys = new LocalKeyProvider(k());
    const a = await encryptSecret("super-secret-refresh-token", keys, "owner-1");
    const b = await encryptSecret("super-secret-refresh-token", keys, "owner-1");
    expect(JSON.stringify(a)).not.toContain("super-secret");
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.wrappedDek).not.toBe(b.wrappedDek);
    expect(await decryptSecret(a, keys, "owner-1")).toBe("super-secret-refresh-token");
  });

  it("detects tampering with any field", async () => {
    const keys = new LocalKeyProvider(k());
    const enc = await encryptSecret("token", keys, "o");
    const flip = (s: string) => Buffer.from(Buffer.from(s, "base64").map((b, i) => (i === 0 ? b ^ 1 : b))).toString("base64");
    for (const field of ["ciphertext", "nonce", "authTag", "wrappedDek"] as const) {
      await expect(decryptSecret({ ...enc, [field]: flip(enc[field]) }, keys, "o")).rejects.toThrow("could not be decrypted");
    }
  });

  it("binds ciphertext to its owner so it cannot be moved to another row", async () => {
    const keys = new LocalKeyProvider(k());
    const enc = await encryptSecret("token", keys, "user-1:conn-1");
    await expect(decryptSecret(enc, keys, "user-2:conn-9")).rejects.toThrow();
    await expect(decryptSecret(enc, keys)).rejects.toThrow();
  });

  it("failure messages reveal nothing about why decryption failed", async () => {
    const enc = await encryptSecret("token", new LocalKeyProvider(k()));
    const err = await decryptSecret(enc, new LocalKeyProvider(k())).catch((e) => e);
    expect(String(err.message)).toBe("Stored credential could not be decrypted.");
  });
});

describe("key ring and rotation", () => {
  const v1 = k();
  const v2 = k();

  it("reads old versions and writes with the current one", async () => {
    const oldRing = new KeyRingProvider({ v1 }, "v1");
    const enc = await encryptSecret("t", oldRing, "o");
    const ring = new KeyRingProvider({ v1, v2 }, "v2");
    expect(await decryptSecret(enc, ring, "o")).toBe("t");
    expect((await encryptSecret("t", ring, "o")).keyVersion).toBe("v2");
  });

  it("rewraps the data key without touching the payload, after which the old key can be retired", async () => {
    const enc = await encryptSecret("t", new KeyRingProvider({ v1 }, "v1"), "o");
    const ring = new KeyRingProvider({ v1, v2 }, "v2");
    const rewrapped = await rewrapSecret(enc, ring);
    expect(rewrapped.keyVersion).toBe("v2");
    expect(rewrapped.ciphertext).toBe(enc.ciphertext);
    expect(rewrapped.wrappedDek).not.toBe(enc.wrappedDek);
    const retired = new KeyRingProvider({ v2 }, "v2");
    expect(await decryptSecret(rewrapped, retired, "o")).toBe("t");
    await expect(decryptSecret(enc, retired, "o")).rejects.toThrow();
    expect(await rewrapSecret(rewrapped, ring)).toBe(rewrapped);
  });

  it("a wrapped key cannot be relabeled as a different key version", async () => {
    const ring = new KeyRingProvider({ v1, v2 }, "v1");
    const enc = await encryptSecret("t", ring, "o");
    await expect(decryptSecret({ ...enc, keyVersion: "v2" }, ring, "o")).rejects.toThrow();
  });

  it("rejects bad key material without echoing it", () => {
    const bad = "c2hvcnQ=";
    expect(() => new KeyRingProvider({ v1: bad }, "v1")).toThrow(/32 bytes/);
    try {
      new KeyRingProvider({ v1: bad }, "v1");
    } catch (e) {
      expect(String(e)).not.toContain(bad);
    }
    expect(() => new KeyRingProvider({ v1 }, "v9")).toThrow(/not present/);
    expect(() => new KeyRingProvider({ "bad version!": v1 }, "bad version!")).toThrow();
  });

  it("parses SECRET_KEYS strictly", () => {
    expect(parseKeyRing(`v1:${v1}, v2:${v2}`)).toEqual({ v1, v2 });
    expect(() => parseKeyRing("")).toThrow();
    expect(() => parseKeyRing("nocolon")).toThrow();
    expect(() => parseKeyRing(`v1:${v1},v1:${v2}`)).toThrow(/duplicate/);
  });
});

describe("KMS-backed provider", () => {
  /** Stand-in for Cloud KMS: the KEK lives only inside this closure, never in the provider. */
  function fakeKms(): KmsClient & { calls: string[] } {
    const kek = new LocalKeyProvider(k(), "kms");
    const calls: string[] = [];
    return {
      calls,
      async encrypt(plaintext, context) {
        calls.push(`encrypt:${context}`);
        return kek.wrapKey(plaintext);
      },
      async decrypt(ciphertext) {
        calls.push("decrypt");
        return kek.unwrapKey(ciphertext, "kms");
      },
    };
  }

  it("wraps and unwraps through the KMS and round-trips", async () => {
    const kms = fakeKms();
    const keys = new KmsKeyProvider(kms, "kms-key-1");
    const enc = await encryptSecret("t", keys, "o");
    expect(enc.keyVersion).toBe("kms-key-1");
    expect(await decryptSecret(enc, keys, "o")).toBe("t");
    expect(kms.calls).toEqual(["encrypt:kek:kms-key-1", "decrypt"]);
  });
});

describe("createKeyProviderFromEnv", () => {
  it("uses the configured key ring", async () => {
    const key = k();
    const { provider, ephemeral } = createKeyProviderFromEnv({ SECRET_KEYS: `v1:${key}`, NODE_ENV: "production" });
    expect(ephemeral).toBe(false);
    expect(provider.keyVersion).toBe("v1");
  });

  it("defaults to the newest key and honors SECRET_CURRENT_KEY_VERSION", () => {
    const spec = `v1:${k()},v2:${k()}`;
    expect(createKeyProviderFromEnv({ SECRET_KEYS: spec }).provider.keyVersion).toBe("v2");
    expect(createKeyProviderFromEnv({ SECRET_KEYS: spec, SECRET_CURRENT_KEY_VERSION: "v1" }).provider.keyVersion).toBe("v1");
  });

  it("falls back to an ephemeral key in development only", () => {
    expect(createKeyProviderFromEnv({ NODE_ENV: "development" }).ephemeral).toBe(true);
    expect(() => createKeyProviderFromEnv({ NODE_ENV: "production" })).toThrow(/SECRET_KEYS must be configured/);
  });

  it("ephemeral keys differ per process start, so data written with one is unreadable later", async () => {
    const a = createKeyProviderFromEnv({}).provider;
    const b = createKeyProviderFromEnv({}).provider;
    const enc = await encryptSecret("t", a, "o");
    await expect(decryptSecret(enc, b, "o")).rejects.toThrow();
  });
});
