const path = require("path");

/** @type {import('jest').Config} */
module.exports = {
  // rootDir на корень монорепо — как в остальных воркспейсах: иначе маппер
  // @sweethome/shared не дотянется до packages/shared/src.
  rootDir: path.resolve(__dirname, "../.."),
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/packages/home-mcp/src"],
  testMatch: ["**/*.test.ts"],
  moduleNameMapper: {
    "^@sweethome/shared$": "<rootDir>/packages/shared/src/index.ts",
  },
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "<rootDir>/packages/home-mcp/tsconfig.test.json" }],
  },
  collectCoverageFrom: ["packages/home-mcp/src/**/*.ts", "!packages/home-mcp/src/**/*.test.ts"],
  coverageDirectory: "<rootDir>/packages/home-mcp/coverage",
};
