const path = require("path");

/** @type {import('jest').Config} */
module.exports = {
  // Jest's own rootDir (distinct from the ts-jest/TS "rootDir") is pinned to the monorepo
  // root, not this server/ directory. This matters for coverage: babel-plugin-istanbul
  // (Jest's default coverage instrumenter) silently refuses to instrument any file that
  // falls outside Jest's `rootDir` ("cwd" in its terms) - so with rootDir = server/, the
  // shared/src files listed in collectCoverageFrom below would never get instrumented, no
  // matter what the ts-jest tsconfig allows.
  rootDir: path.resolve(__dirname, ".."),
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/server/src", "<rootDir>/shared/src"],
  testMatch: ["**/*.test.ts"],
  moduleNameMapper: {
    "^@inverter/shared$": "<rootDir>/shared/src/index.ts",
  },
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "<rootDir>/server/tsconfig.test.json" }],
  },
  collectCoverageFrom: [
    "server/src/**/*.ts",
    "!server/src/index.ts",
    "!server/src/**/types.ts",
    "!server/src/**/*.d.ts",
    "shared/src/api.ts",
    "shared/src/auth.ts",
  ],
  coverageDirectory: "<rootDir>/server/coverage",
  coverageReporters: ["text", "html"],
  clearMocks: true,
};
