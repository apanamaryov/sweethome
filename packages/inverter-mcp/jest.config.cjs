const path = require("path");

/** @type {import('jest').Config} */
module.exports = {
  // rootDir на корень монорепо — как в server/jest.config.cjs: иначе маппер
  // @sweethome/inverter-shared не дотянется до packages/inverter-shared/src.
  rootDir: path.resolve(__dirname, "../.."),
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/packages/inverter-mcp/src"],
  testMatch: ["**/*.test.ts"],
  moduleNameMapper: {
    "^@sweethome/inverter-shared$": "<rootDir>/packages/inverter-shared/src/index.ts",
    "^@sweethome/shared$": "<rootDir>/packages/shared/src/index.ts",
    "^@sweethome/home-mcp$": "<rootDir>/packages/home-mcp/src/index.ts",
  },
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "<rootDir>/packages/inverter-mcp/tsconfig.test.json" }],
  },
  collectCoverageFrom: [
    "packages/inverter-mcp/src/**/*.ts",
    "!packages/inverter-mcp/src/**/*.test.ts",
    "!packages/inverter-mcp/src/testing/**",
  ],
  coverageDirectory: "<rootDir>/packages/inverter-mcp/coverage",
};
