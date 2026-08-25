const path = require("path");

/** @type {import('jest').Config} */
module.exports = {
  rootDir: path.resolve(__dirname, "../.."),
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/modules/cctv/src"],
  testMatch: ["**/*.test.ts"],
  moduleNameMapper: {
    "^@sweethome/cctv-shared$": "<rootDir>/packages/cctv-shared/src/index.ts",
    "^@sweethome/home-mcp$": "<rootDir>/packages/home-mcp/src/index.ts",
    "^@sweethome/shared$": "<rootDir>/packages/shared/src/index.ts",
    "^@sweethome/shared/module$": "<rootDir>/packages/shared/src/module.ts",
  },
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "<rootDir>/modules/cctv/tsconfig.test.json" }],
  },
  collectCoverageFrom: ["modules/cctv/src/**/*.ts", "!modules/cctv/src/**/*.test.ts"],
  coverageDirectory: "<rootDir>/modules/cctv/coverage",
  clearMocks: true,
};
