import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import prettierConfig from "eslint-config-prettier";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettierConfig,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-non-null-assertion": "off",
      "no-console": "off",
      "no-empty": ["error", { "allowEmptyCatch": true }],
    },
  },
  {
    ignores: ["dist/", "node_modules/", "agents/", "logs/", "*.js", "coverage/", "plugins/claude-code/"],
  },
);
