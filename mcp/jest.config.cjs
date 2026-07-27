const path = require("path");

/** @type {import('jest').Config} */
module.exports = {
  // rootDir на корень монорепо — как в server/jest.config.cjs: иначе маппер
  // @inverter/shared не дотянется до shared/src.
  rootDir: path.resolve(__dirname, ".."),
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/mcp/src"],
  testMatch: ["**/*.test.ts"],
  moduleNameMapper: {
    "^@inverter/shared$": "<rootDir>/shared/src/index.ts",
  },
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "<rootDir>/mcp/tsconfig.test.json" }],
  },
  collectCoverageFrom: ["mcp/src/**/*.ts", "!mcp/src/**/*.test.ts", "!mcp/src/testing/**"],
  coverageDirectory: "<rootDir>/mcp/coverage",
};
