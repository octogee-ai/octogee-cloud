import js from "@eslint/js";
import tseslint from "typescript-eslint";
import sonarjs from "eslint-plugin-sonarjs";
import security from "eslint-plugin-security";
import globals from "globals";

export const recommended = [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  sonarjs.configs.recommended,
  security.configs.recommended,
  {
    rules: {
      complexity: ["warn", { max: 15 }],
      "max-lines-per-function": ["warn", { max: 200, skipBlankLines: true, skipComments: true, IIFEs: true }],
      "max-depth": ["warn", 4],
      "max-params": ["warn", 5],
      "max-nested-callbacks": ["warn", 4],

      "sonarjs/cognitive-complexity": ["warn", 20],
      "sonarjs/no-duplicate-string": ["warn", { threshold: 5 }],
      "sonarjs/no-identical-functions": "warn",
      "sonarjs/no-redundant-jump": "warn",
      "sonarjs/no-nested-conditional": "warn",
      "sonarjs/no-nested-functions": "warn",
      "sonarjs/no-nested-template-literals": "warn",
      "sonarjs/no-nested-assignment": "warn",
      "sonarjs/no-all-duplicated-branches": "warn",
      "sonarjs/no-redundant-boolean": "warn",
      "sonarjs/no-unenclosed-multiline-block": "warn",
      "sonarjs/no-unused-collection": "warn",
      "sonarjs/no-empty-collection": "warn",
      "sonarjs/use-type-alias": "warn",
      "sonarjs/no-dead-store": "warn",
      "sonarjs/no-redundant-optional": "off",
      "sonarjs/unused-import": "off",
      "sonarjs/no-unused-vars": "off",
      "sonarjs/prefer-immediate-return": "off",
      "sonarjs/no-small-switch": "off",
      "sonarjs/todo-tag": "off",
      "sonarjs/no-commented-code": "off",
      "sonarjs/parameterized-tests": "warn",

      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-require-imports": "off",

      "no-unused-vars": "off",
      "no-empty": ["warn", { allowEmptyCatch: true }],
      "no-useless-assignment": "off",
      "preserve-caught-error": "off",

      "security/detect-object-injection": "off",
      "security/detect-non-literal-regexp": "warn",
      "security/detect-non-literal-fs-filename": "off",
      "security/detect-non-literal-require": "warn",
      "security/detect-unsafe-regex": "off",
      "security/detect-buffer-noassert": "warn",
      "security/detect-child-process": "warn",
      "security/detect-disable-mustache-escape": "warn",
      "security/detect-eval-with-expression": "warn",
      "security/detect-no-csrf-before-method-override": "warn",
      "security/detect-possible-timing-attacks": "warn",
      "security/detect-pseudoRandomBytes": "warn",
      "security/detect-new-buffer": "warn",
      "security/detect-bidi-characters": "warn"
    }
  }
];

export const nodeGlobals = {
  languageOptions: { globals: { ...globals.node, ...globals.es2022 } }
};

export const operatorTooling = {
  rules: {
    complexity: "off",
    "max-depth": "off",
    "max-lines-per-function": "off",
    "max-nested-callbacks": "off",
    "sonarjs/cognitive-complexity": "off",
    "sonarjs/no-nested-conditional": "off",
    "sonarjs/no-nested-template-literals": "off",
    "sonarjs/no-nested-functions": "off",
    "sonarjs/no-duplicate-string": "off",
    "sonarjs/no-identical-functions": "off",
    "security/detect-non-literal-fs-filename": "off",
    "security/detect-non-literal-regexp": "off",
    "security/detect-non-literal-require": "off",
    "security/detect-child-process": "off"
  }
};

export const testFiles = {
  languageOptions: {
    globals: {
      ...globals.node,
      ...globals.es2022,
      describe: "readonly",
      it: "readonly",
      test: "readonly",
      expect: "readonly",
      beforeAll: "readonly",
      beforeEach: "readonly",
      afterAll: "readonly",
      afterEach: "readonly",
      vi: "readonly"
    }
  },
  rules: {
    "max-lines-per-function": "off",
    "max-depth": "off",
    "max-params": "off",
    "max-nested-callbacks": "off",
    complexity: "off",
    "sonarjs/no-duplicate-string": "off",
    "sonarjs/cognitive-complexity": "off",
    "sonarjs/no-identical-functions": "off",
    "sonarjs/no-nested-conditional": "off",
    "sonarjs/no-nested-functions": "off",
    "sonarjs/no-nested-template-literals": "off",
    "sonarjs/no-nested-assignment": "off",
    "sonarjs/no-all-duplicated-branches": "off",
    "sonarjs/no-redundant-boolean": "off",
    "sonarjs/no-unused-collection": "off",
    "sonarjs/no-empty-collection": "off",
    "sonarjs/prefer-specific-assertions": "off",
    "sonarjs/no-trivial-assertions": "off",
    "sonarjs/no-floating-point-equality": "off",
    "sonarjs/no-skipped-tests": "off",
    "@typescript-eslint/no-explicit-any": "off",

    "sonarjs/no-clear-text-protocols": "off",
    "sonarjs/slow-regex": "off",
    "sonarjs/super-linear-regex": "off",
    "sonarjs/os-command": "off",
    "sonarjs/no-os-command-from-path": "off",
    "sonarjs/file-permissions": "off",
    "sonarjs/publicly-writable-directories": "off",
    "sonarjs/code-eval": "off",
    "sonarjs/no-hardcoded-passwords": "off",
    "sonarjs/hardcoded-secret-signatures": "off",
    "sonarjs/no-hardcoded-ip": "off",
    "sonarjs/pseudo-random": "off",
    "sonarjs/single-character-alternation": "off",
    "@typescript-eslint/ban-ts-comment": "off",
    "@typescript-eslint/no-unused-expressions": "off",

    "security/detect-non-literal-regexp": "off",
    "security/detect-non-literal-fs-filename": "off",
    "security/detect-non-literal-require": "off",
    "security/detect-child-process": "off",
    "security/detect-eval-with-expression": "off",
    "security/detect-pseudoRandomBytes": "off",
    "security/detect-possible-timing-attacks": "off"
  }
};

export const testFilePatterns = ["**/*.{test,spec}.{ts,tsx}", "**/__tests__/**/*.{ts,tsx}"];

export const configFiles = {
  files: ["**/*.config.{js,mjs,cjs,ts}", "**/vite.config.*", "**/vitest.config.*", "**/astro.config.*"],
  rules: {
    "max-lines-per-function": "off",
    complexity: "off",
    "sonarjs/no-os-command-from-path": "off",
    "sonarjs/os-command": "off"
  }
};

export const ignores = [
  "**/node_modules/**",
  "**/dist/**",
  "**/coverage/**",
  "**/.astro/**",
  "**/templates/**/*.md",
  "**/templates/**/*.html",
  "**/*.min.js",
  "**/*.d.ts"
];

export default [
  {
    ignores: [
      ...ignores,
      "desktop/rootfs/usr/share/omarchy/octo-desktop/plugins/**",
      "tests/fixtures/**",
      "gateway-edge/src/vendor/openclaw-browser-resources/**"
    ]
  },
  ...recommended,
  { files: ["**/*.{ts,mjs,js,cjs}"], ...nodeGlobals },
  {
    files: ["desktop/rootfs/usr/share/omarchy/octo-desktop/desk/**/*.js"],
    languageOptions: { sourceType: "script", globals: { ...globals.browser } }
  },
  { files: ["scripts/ops/**/*.{ts,mjs,js}", "gateway-supervisor/ops/**/*.{ts,mjs,js}"], ...operatorTooling },
  { files: [...testFilePatterns, "tests/**/*.ts"], ...testFiles },
  configFiles
];
