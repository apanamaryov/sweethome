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
  roots: ["<rootDir>/server/src", "<rootDir>/packages/inverter-shared/src", "<rootDir>/packages/shared/src"],
  testMatch: ["**/*.test.ts"],
  moduleNameMapper: {
    "^@sweethome/inverter-shared$": "<rootDir>/packages/inverter-shared/src/index.ts",
    "^@sweethome/shared$": "<rootDir>/packages/shared/src/index.ts",
    "^@sweethome/shared/module$": "<rootDir>/packages/shared/src/module.ts",
  },
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "<rootDir>/server/tsconfig.test.json" }],
  },
  collectCoverageFrom: [
    "server/src/**/*.ts",
    "!server/src/index.ts",
    "!server/src/**/*.d.ts",
    "packages/inverter-shared/src/api.ts",
    "packages/inverter-shared/src/source.ts",
    "packages/shared/src/auth.ts",
    "packages/shared/src/module.ts",
  ],
  coverageDirectory: "<rootDir>/server/coverage",
  coverageReporters: ["text", "html"],
  clearMocks: true,
};
