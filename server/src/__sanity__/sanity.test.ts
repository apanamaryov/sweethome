import { OUTPUT_SOURCE_PRIORITY } from "@sweethome/inverter-shared";

describe("jest sanity", () => {
  it("runs and resolves @sweethome/inverter-shared from source", () => {
    expect(typeof OUTPUT_SOURCE_PRIORITY).toBe("object");
    expect(2 + 2).toBe(4);
  });
});
