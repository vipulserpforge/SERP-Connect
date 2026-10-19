import { loadWebEnv, type WebEnv } from "@serp/contracts";

/** Parsed once per process; throws a names-only error if configuration is invalid or unsafe. */
let cached: WebEnv | undefined;

export function getEnv(): WebEnv {
  return (cached ??= loadWebEnv());
}
