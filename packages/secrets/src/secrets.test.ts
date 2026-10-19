import { describe, expect, it } from "vitest";
import { LocalKeyProvider, decryptSecret, encryptSecret, generateLocalMasterKey } from "./index.js";

describe("envelope encryption", () => {
  const keys = new LocalKeyProvider(generateLocalMasterKey());

  it("round-trips and never stores plaintext", async () => {
    const enc = await encryptSecret("refresh-token-123", keys, "conn-1");
    expect(JSON.stringify(enc)).not.toContain("refresh-token-123");
    expect(await decryptSecret(enc, keys, "conn-1")).toBe("refresh-token-123");
  });

  it("rejects ciphertext moved to another owner (AAD mismatch)", async () => {
    const enc = await encryptSecret("secret", keys, "conn-1");
    await expect(decryptSecret(enc, keys, "conn-2")).rejects.toThrow("could not be decrypted");
  });

  it("rejects a different master key", async () => {
    const enc = await encryptSecret("secret", keys);
    await expect(decryptSecret(enc, new LocalKeyProvider(generateLocalMasterKey()))).rejects.toThrow();
  });

  it("rejects a master key of the wrong length", () => {
    expect(() => new LocalKeyProvider("c2hvcnQ=")).toThrow();
  });
});
