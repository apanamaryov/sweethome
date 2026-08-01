import { canAccess } from "./auth";

// Migrated 1:1 from scripts/selfcheck-auth.ts section 5 (access matrix), expanded into
// a full role x required-access truth table.

describe("canAccess", () => {
  it("public is accessible without a session and to every role", () => {
    expect(canAccess(null, "public")).toBe(true);
    expect(canAccess("viewer", "public")).toBe(true);
    expect(canAccess("admin", "public")).toBe(true);
  });

  it("auth requires a session but no particular role", () => {
    expect(canAccess(null, "auth")).toBe(false);
    expect(canAccess("viewer", "auth")).toBe(true);
    expect(canAccess("admin", "auth")).toBe(true);
  });

  it("admin-required is denied without a session and to viewer, allowed for admin", () => {
    expect(canAccess(null, "admin")).toBe(false);
    expect(canAccess("viewer", "admin")).toBe(false);
    expect(canAccess("admin", "admin")).toBe(true);
  });

  it.each([
    [null, "public", true],
    [null, "auth", false],
    [null, "admin", false],
    ["viewer", "public", true],
    ["viewer", "auth", true],
    ["viewer", "admin", false],
    ["admin", "public", true],
    ["admin", "auth", true],
    ["admin", "admin", true],
  ] as const)("canAccess(%s, %s) === %s", (role, required, expected) => {
    expect(canAccess(role, required)).toBe(expected);
  });
});
