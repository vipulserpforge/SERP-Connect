import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { ConnectorException } from "@serp/contracts";

/**
 * Envelope encryption.
 *
 *   plaintext --AES-256-GCM(DEK)--> ciphertext        (DEK is random, one per secret)
 *   DEK       --KeyProvider.wrapKey--> wrappedDek      (wrapped by a key-encryption key, KEK)
 *
 * The KEK never sits next to the data. Implementations of KeyProvider decide where it lives:
 *   - KeyRingProvider  KEKs injected from a secret manager as env vars (rotation by version)
 *   - KmsKeyProvider   KEK stays inside a managed KMS; this process never sees it
 *   - ephemeral dev key (see createKeyProviderFromEnv), refused in production
 */
export interface KeyProvider {
  /** Version stamped on newly wrapped keys. */
  readonly keyVersion: string;
  wrapKey(dek: Buffer): Promise<Buffer>;
  unwrapKey(wrapped: Buffer, keyVersion: string): Promise<Buffer>;
}

export interface EncryptedSecret {
  ciphertext: string;
  nonce: string;
  authTag: string;
  wrappedDek: string;
  keyVersion: string;
}

const ALGO = "aes-256-gcm";
const b64 = (b: Buffer) => b.toString("base64");

function gcmEncrypt(key: Buffer, plaintext: Buffer, aad?: Buffer) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, nonce);
  if (aad) cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, nonce, authTag: cipher.getAuthTag() };
}

function gcmDecrypt(key: Buffer, data: { ciphertext: Buffer; nonce: Buffer; authTag: Buffer }, aad?: Buffer) {
  const decipher = createDecipheriv(ALGO, key, data.nonce);
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(data.authTag);
  return Buffer.concat([decipher.update(data.ciphertext), decipher.final()]);
}

const wrapWith = (kek: Buffer, dek: Buffer, version: string): Buffer => {
  // The version is authenticated so a wrapped key cannot be relabeled to a different KEK version.
  const { ciphertext, nonce, authTag } = gcmEncrypt(kek, dek, Buffer.from(`kek:${version}`));
  return Buffer.concat([nonce, authTag, ciphertext]);
};

const unwrapWith = (kek: Buffer, wrapped: Buffer, version: string): Buffer =>
  gcmDecrypt(
    kek,
    { nonce: wrapped.subarray(0, 12), authTag: wrapped.subarray(12, 28), ciphertext: wrapped.subarray(28) },
    Buffer.from(`kek:${version}`),
  );

const VERSION_RE = /^[A-Za-z0-9._-]{1,32}$/;

function decodeKek(base64: string, label: string): Buffer {
  const key = Buffer.from(base64, "base64");
  // Never include the value in the message.
  if (key.length !== 32) throw new Error(`Key ${label} must be 32 bytes, base64-encoded.`);
  return key;
}

/** KEKs keyed by version. New secrets use `currentVersion`; older versions stay readable until rewrapped. */
export class KeyRingProvider implements KeyProvider {
  private readonly keks = new Map<string, Buffer>();

  constructor(
    keys: Record<string, string>,
    readonly keyVersion: string,
  ) {
    for (const [version, value] of Object.entries(keys)) {
      if (!VERSION_RE.test(version)) throw new Error("Invalid key version label.");
      this.keks.set(version, decodeKek(value, version));
    }
    if (!this.keks.has(keyVersion)) throw new Error("Current key version is not present in the key ring.");
  }

  get versions(): string[] {
    return [...this.keks.keys()];
  }

  async wrapKey(dek: Buffer): Promise<Buffer> {
    return wrapWith(this.keks.get(this.keyVersion)!, dek, this.keyVersion);
  }

  async unwrapKey(wrapped: Buffer, keyVersion: string): Promise<Buffer> {
    const kek = this.keks.get(keyVersion);
    if (!kek) throw new Error("Unknown key version.");
    return unwrapWith(kek, wrapped, keyVersion);
  }
}

/** Single-key convenience for tests and local development. */
export class LocalKeyProvider extends KeyRingProvider {
  constructor(masterKeyBase64: string, keyVersion = "local-v1") {
    super({ [keyVersion]: masterKeyBase64 }, keyVersion);
  }
}

/**
 * The only operations a KMS must offer for envelope encryption. A Cloud KMS / AWS KMS client
 * implements this; the KEK never leaves the service. `context` is authenticated by the KMS.
 */
export interface KmsClient {
  encrypt(plaintext: Buffer, context: string): Promise<Buffer>;
  decrypt(ciphertext: Buffer, context: string): Promise<Buffer>;
}

/** KEK held in a managed KMS. `keyVersion` identifies the KMS key (or key version) for rotation. */
export class KmsKeyProvider implements KeyProvider {
  constructor(
    private readonly kms: KmsClient,
    readonly keyVersion: string,
  ) {}

  wrapKey(dek: Buffer): Promise<Buffer> {
    return this.kms.encrypt(dek, `kek:${this.keyVersion}`);
  }

  unwrapKey(wrapped: Buffer, keyVersion: string): Promise<Buffer> {
    return this.kms.decrypt(wrapped, `kek:${keyVersion}`);
  }
}

export function generateLocalMasterKey(): string {
  return b64(randomBytes(32));
}

/** `aad` binds the ciphertext to its owner (e.g. user + connection) so it cannot be moved between rows. */
export async function encryptSecret(plaintext: string, keys: KeyProvider, aad?: string): Promise<EncryptedSecret> {
  const dek = randomBytes(32);
  try {
    const enc = gcmEncrypt(dek, Buffer.from(plaintext, "utf8"), aad ? Buffer.from(aad) : undefined);
    const wrapped = await keys.wrapKey(dek);
    return {
      ciphertext: b64(enc.ciphertext),
      nonce: b64(enc.nonce),
      authTag: b64(enc.authTag),
      wrappedDek: b64(wrapped),
      keyVersion: keys.keyVersion,
    };
  } finally {
    dek.fill(0);
  }
}

export async function decryptSecret(secret: EncryptedSecret, keys: KeyProvider, aad?: string): Promise<string> {
  let dek: Buffer | undefined;
  try {
    dek = await keys.unwrapKey(Buffer.from(secret.wrappedDek, "base64"), secret.keyVersion);
    const plain = gcmDecrypt(
      dek,
      {
        ciphertext: Buffer.from(secret.ciphertext, "base64"),
        nonce: Buffer.from(secret.nonce, "base64"),
        authTag: Buffer.from(secret.authTag, "base64"),
      },
      aad ? Buffer.from(aad) : undefined,
    );
    return plain.toString("utf8");
  } catch (cause) {
    // Deliberately opaque: never reveal why decryption failed.
    throw new ConnectorException("INTERNAL_ERROR", "Stored credential could not be decrypted.", { cause });
  } finally {
    dek?.fill(0);
  }
}

/**
 * Key rotation without touching the encrypted payload: unwrap the DEK with the old KEK and wrap
 * it with the current one. Returns the input unchanged if already on the current version.
 */
export async function rewrapSecret(secret: EncryptedSecret, keys: KeyProvider): Promise<EncryptedSecret> {
  if (secret.keyVersion === keys.keyVersion) return secret;
  let dek: Buffer | undefined;
  try {
    dek = await keys.unwrapKey(Buffer.from(secret.wrappedDek, "base64"), secret.keyVersion);
    const wrapped = await keys.wrapKey(dek);
    return { ...secret, wrappedDek: b64(wrapped), keyVersion: keys.keyVersion };
  } catch (cause) {
    throw new ConnectorException("INTERNAL_ERROR", "Stored credential could not be re-encrypted.", { cause });
  } finally {
    dek?.fill(0);
  }
}

/** Parses `v1:<base64>,v2:<base64>`. Errors never echo key material. */
export function parseKeyRing(spec: string): Record<string, string> {
  const ring: Record<string, string> = {};
  for (const entry of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const idx = entry.indexOf(":");
    if (idx < 1) throw new Error("SECRET_KEYS entries must look like <version>:<base64 key>.");
    const version = entry.slice(0, idx);
    if (version in ring) throw new Error("SECRET_KEYS contains a duplicate version.");
    ring[version] = entry.slice(idx + 1);
  }
  if (Object.keys(ring).length === 0) throw new Error("SECRET_KEYS is empty.");
  return ring;
}

export interface KeyProviderEnv {
  NODE_ENV?: string;
  /** `v1:<base64 32 bytes>,v2:<...>`. Inject from a secret manager; never commit. */
  SECRET_KEYS?: string;
  /** Which version in SECRET_KEYS encrypts new data. */
  SECRET_CURRENT_KEY_VERSION?: string;
}

/**
 * Builds the key provider for this process.
 *  - Configured: a KeyRingProvider.
 *  - Not configured, development/test: an ephemeral in-memory key (data written with it is unreadable
 *    after a restart, which is fine for mock data and makes accidental reliance on it obvious).
 *  - Not configured, production: throws. There is no silent fallback.
 */
export function createKeyProviderFromEnv(env: KeyProviderEnv = process.env): { provider: KeyProvider; ephemeral: boolean } {
  if (env.SECRET_KEYS) {
    const ring = parseKeyRing(env.SECRET_KEYS);
    const current = env.SECRET_CURRENT_KEY_VERSION ?? Object.keys(ring).at(-1)!;
    return { provider: new KeyRingProvider(ring, current), ephemeral: false };
  }
  if (env.NODE_ENV === "production") {
    throw new Error("SECRET_KEYS must be configured in production.");
  }
  return { provider: new LocalKeyProvider(generateLocalMasterKey(), "dev-ephemeral"), ephemeral: true };
}

/**
 * Keyed, one-way fingerprint of a provider token (HMAC-SHA256). Lets the app recognise "the same token" for quota
 * grouping and duplicate detection without storing or comparing the token itself. Not reversible and not
 * unique across keys: changing the key changes every fingerprint.
 */
export interface Fingerprinter {
  /** Lower-case hex, 64 characters. */
  fingerprint(value: string): string;
  /** True when the key is a throwaway development key. */
  readonly ephemeral: boolean;
}

export interface FingerprintEnv {
  NODE_ENV?: string;
  CREDENTIAL_FINGERPRINT_KEY?: string;
}

export function createFingerprinterFromEnv(env: FingerprintEnv = process.env): Fingerprinter {
  let key: Buffer;
  let ephemeral = false;
  if (env.CREDENTIAL_FINGERPRINT_KEY) {
    key = Buffer.from(env.CREDENTIAL_FINGERPRINT_KEY, "base64");
    if (key.length !== 32) throw new Error("CREDENTIAL_FINGERPRINT_KEY must be 32 bytes, base64-encoded.");
  } else if (env.NODE_ENV === "production") {
    throw new ConnectorException("PROVIDER_CAPABILITY_UNAVAILABLE", "Clarity and Bing API-key connections are not configured on this server yet.", {
      suggestedAction: "The operator must set CREDENTIAL_FINGERPRINT_KEY (see docs/CLARITY.md).",
    });
  } else {
    key = randomBytes(32);
    ephemeral = true;
  }
  return { ephemeral, fingerprint: (value) => createHmac("sha256", key).update(value, "utf8").digest("hex") };
}
