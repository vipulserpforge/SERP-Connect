import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// End-to-end tests start the built web app; run with `pnpm test:e2e`.
const packagesDir = fileURLToPath(new URL("./packages", import.meta.url));
const alias = Object.fromEntries(
  readdirSync(packagesDir).flatMap((name) => [
    [`@serp/${name}/supabase`, `${packagesDir}/${name}/src/supabase.ts`],
    [`@serp/${name}`, `${packagesDir}/${name}/src/index.ts`],
  ]),
);

export default defineConfig({
  resolve: { alias },
  test: { include: ["tests/e2e/**/*.e2e.ts"], environment: "node", testTimeout: 30_000, fileParallelism: false },
});
