import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Resolve @serp/* to package sources so tests run without a prior build.
const packagesDir = fileURLToPath(new URL("./packages", import.meta.url));
const alias = Object.fromEntries(
  readdirSync(packagesDir).flatMap((name) => [
    [`@serp/${name}/supabase`, `${packagesDir}/${name}/src/supabase.ts`],
    [`@serp/${name}`, `${packagesDir}/${name}/src/index.ts`],
  ]),
);

export default defineConfig({
  resolve: { alias },
  test: {
    include: ["packages/**/src/**/*.test.ts", "tests/**/*.test.ts"],
    environment: "node",
  },
});
