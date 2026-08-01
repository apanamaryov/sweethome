import nextJest from "next/jest.js";

const createJestConfig = nextJest({ dir: "./" });

/** @type {import('jest').Config} */
const config = {
  testEnvironment: "jsdom",
  setupFilesAfterEnv: ["<rootDir>/jest.setup.ts"],
  moduleNameMapper: {
    "^@sweethome/inverter-shared$": "<rootDir>/../packages/inverter-shared/src/index.ts",
    "^@sweethome/shared$": "<rootDir>/../packages/shared/src/index.ts",
    // next/jest только резолвит "@/*" через SWC-транспиляцию import-стейтментов;
    // строковый аргумент jest.mock("@/...") этой трансформации не подвергается,
    // поэтому нужен явный маппер для рантайм-резолва jest (см. web/components/SolarToday.test.tsx).
    "^@/(.*)$": "<rootDir>/$1",
  },
  collectCoverageFrom: [
    "lib/**/*.{ts,tsx}",
    "components/**/*.{ts,tsx}",
    "app/**/*.{ts,tsx}",
    "!**/*.d.ts",
  ],
  coverageReporters: ["text", "html"],
  clearMocks: true,
};

export default createJestConfig(config);
