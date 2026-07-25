/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src", "<rootDir>/../shared/src"],
  testMatch: ["**/*.test.ts"],
  moduleNameMapper: {
    "^@inverter/shared$": "<rootDir>/../shared/src/index.ts",
  },
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "<rootDir>/tsconfig.json" }],
  },
  collectCoverageFrom: [
    "src/**/*.ts",
    "!src/index.ts",
    "!src/**/types.ts",
    "!src/**/*.d.ts",
    "../shared/src/api.ts",
    "../shared/src/auth.ts",
  ],
  coverageReporters: ["text", "html"],
  clearMocks: true,
};
