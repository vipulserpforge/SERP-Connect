import { CredentialService, OAuthFlowService } from "@serp/credentials";
import { MockRepository } from "@serp/db";
import { createLogger } from "@serp/observability";
import { MOCK_CLIENT_ID, MockGoogleOAuthClient } from "@serp/provider-google";
import { KeyRingProvider, generateLocalMasterKey, type KeyProvider } from "@serp/secrets";

export const USER_1 = "11111111-1111-4111-8111-111111111111";
export const USER_2 = "22222222-2222-4222-8222-222222222222";

/** Everything needed to exercise the credential lifecycle with no network and no real secrets. */
export function makeStack(overrides: { keys?: KeyProvider; repo?: MockRepository } = {}) {
  const repo = overrides.repo ?? new MockRepository({ connections: [], properties: [] });
  const keys = overrides.keys ?? new KeyRingProvider({ v1: generateLocalMasterKey() }, "v1");
  const time = { now: 1_800_000_000_000 };
  const clock = () => time.now;
  const google = new MockGoogleOAuthClient(clock);
  const logs: string[] = [];
  const logger = createLogger({ level: "debug", write: (l) => logs.push(l) });
  const credentials = new CredentialService({ creds: repo, repo, keys, google, logger, clock });
  const oauth = new OAuthFlowService({
    creds: repo,
    repo,
    keys,
    google,
    credentials,
    logger,
    clock,
    config: { clientId: MOCK_CLIENT_ID, redirectUri: "http://localhost:3000/api/oauth/google/callback" },
  });

  /** Runs a full begin -> (fake consent) -> complete cycle. */
  async function connect(userId: string, email: string, product: "gsc" | "ga4" = "gsc") {
    const { authorizationUrl } = await oauth.begin(userId, product);
    const state = new URL(authorizationUrl).searchParams.get("state")!;
    const done = await oauth.complete(userId, { state, code: `mock-code:${email}`, error: null });
    return { ...done, state, authorizationUrl };
  }

  return { repo, keys, time, google, logs, logger, credentials, oauth, connect };
}

/** Token-looking strings the stack can produce; none may ever reach logs, audit rows or plaintext storage. */
export const SECRET_PATTERNS = [/mock-access-token-\d+/, /mock-refresh-token-[\w@.]+/];
