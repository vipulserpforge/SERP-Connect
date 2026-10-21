// Bug-focused lint rules (not a style guide). Formatting and naming are left alone on purpose.
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/.next/**", "**/node_modules/**", "**/coverage/**", "**/next-env.d.ts", ".agents/**", ".claude/**", "deploy/**"] },
  {
    files: ["apps/**/*.{ts,tsx}", "packages/**/*.ts", "scripts/**/*.mts", "tests/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: { allowDefaultProject: ["scripts/*.mts", "tests/*/*.ts", "tests/*.ts", "packages/*/src/*.test.ts", "apps/web/next.config.ts"], maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 200 }, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      "@typescript-eslint/no-floating-promises": "error", // a forgotten await silently drops errors
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: { attributes: false } }],
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
      "no-debugger": "error",
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-self-compare": "error",
      "no-unsafe-finally": "error",
      "no-dupe-keys": "error",
      "no-duplicate-case": "error",
      "no-unreachable": "error",
    },
  },
  {
    // Test servers use async request handlers on purpose; a rejected handler fails the test anyway.
    files: ["tests/**/*.ts", "packages/**/*.test.ts"],
    rules: { "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: false }] },
  },
);
