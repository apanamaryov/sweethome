import { hashPassword, verifyPassword, validatePassword, MIN_PASSWORD_LEN } from "./hash";

// Migrated 1:1 from scripts/selfcheck-auth.ts section 1 (hashing/verification/validation).

describe("hashPassword", () => {
  it("produces a 'scrypt$<salt>$<hash>' string", () => {
    const h = hashPassword("s3cret");
    expect(h.startsWith("scrypt$")).toBe(true);
    expect(h.split("$")).toHaveLength(3);
  });

  it("salts randomly: two hashes of the same password differ", () => {
    const a = hashPassword("s3cret");
    const b = hashPassword("s3cret");
    expect(a).not.toBe(b);
  });
});

describe("verifyPassword", () => {
  it("accepts the correct password", () => {
    const h = hashPassword("s3cret");
    expect(verifyPassword("s3cret", h)).toBe(true);
  });

  it("rejects a wrong password", () => {
    const h = hashPassword("s3cret");
    expect(verifyPassword("wrong", h)).toBe(false);
  });

  it("rejects a malformed stored hash without throwing", () => {
    expect(() => verifyPassword("s3cret", "garbage")).not.toThrow();
    expect(verifyPassword("s3cret", "garbage")).toBe(false);
  });
});

describe("validatePassword", () => {
  it(`rejects passwords shorter than ${MIN_PASSWORD_LEN} characters`, () => {
    expect(() => validatePassword("12345")).toThrow();
  });

  it(`accepts a password exactly ${MIN_PASSWORD_LEN} characters long`, () => {
    expect(() => validatePassword("123456")).not.toThrow();
  });
});
