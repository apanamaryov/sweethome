const path = require("path");

/** @type {import('jest').Config} */
module.exports = {
  rootDir: path.resolve(__dirname, "../.."),
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/modules/inverter/src"],
  testMatch: ["**/*.test.ts"],
  moduleNameMapper: {
    "^@sweethome/inverter-shared$": "<rootDir>/packages/inverter-shared/src/index.ts",
    "^@sweethome/home-mcp$": "<rootDir>/packages/home-mcp/src/index.ts",
    "^@sweethome/shared$": "<rootDir>/packages/shared/src/index.ts",
    "^@sweethome/shared/module$": "<rootDir>/packages/shared/src/module.ts",
  },
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "<rootDir>/modules/inverter/tsconfig.test.json" }],
  },
  collectCoverageFrom: ["modules/inverter/src/**/*.ts", "!modules/inverter/src/**/*.test.ts"],
  coverageDirectory: "<rootDir>/modules/inverter/coverage",
  clearMocks: true,
};
