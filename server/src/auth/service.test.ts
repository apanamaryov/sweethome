import fs from "fs";
import os from "os";
import path from "path";
import { Auth } from "./service";

// Migrated + extended from scripts/selfcheck-auth.ts section 6 (login / change-password /
// brute-force). Auth's AuthDb always lives on a real file (constructor does
// fs.mkdirSync(dataDir) + new AuthDb(path.join(dataDir, "auth.db"))) — unlike db.test.ts this
// uses a real tmp directory, not ":memory:".
//
// FAIL_LIMIT / LOCK_MS below must match the real thresholds in service.ts (5 failed attempts
// per IP, 10 minute lockout) — not invented values.
const FAIL_LIMIT = 5;
const LOCK_MS = 10 * 60_000;

describe("Auth", () => {
  let tmp: string;
  let auth: Auth;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "auth-service-test-"));
    auth = new Auth(tmp, 30);
  });

  afterEach(() => {
    auth.db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe("login — success", () => {
    it("returns a token and the seeded admin's role on correct credentials", () => {
      const result = auth.login("admin", "admin", "1.1.1.1");

      expect(result).not.toBeNull();
      expect(result!.token).toEqual(expect.any(String));
      expect(result!.user.username).toBe("admin");
      expect(result!.user.role).toBe("admin");
      expect(result!.user.mustChangePassword).toBe(true); // seeded default, not yet changed
    });

    it("creates a session that verify() resolves back to the same user", () => {
      const { token } = auth.login("admin", "admin", "1.1.1.1")!;

      const session = auth.verify(token);

      expect(session).not.toBeNull();
      expect(session!.username).toBe("admin");
      expect(session!.role).toBe("admin");
    });

    it("verify() returns null for an unknown or absent token", () => {
      expect(auth.verify("not-a-real-token")).toBeNull();
      expect(auth.verify(null)).toBeNull();
    });
  });

  describe("login — failure / anti-brute-force", () => {
    it("rejects a wrong password by returning null, not throwing", () => {
      expect(auth.login("admin", "wrong-password", "1.1.1.1")).toBeNull();
    });

    it("does not lock out before FAIL_LIMIT failures, then locks on the attempt right after", () => {
      const ip = "5.5.5.5";
      // FAIL_LIMIT - 1 wrong attempts: each rejected, none throws (counter below limit).
      for (let i = 0; i < FAIL_LIMIT - 1; i++) {
        expect(auth.login("admin", "wrong", ip)).toBeNull();
      }
      // the FAIL_LIMIT-th failure itself still just returns null — the lockout is only
      // enforced starting on the *next* call, once the counter has already tripped.
      expect(auth.login("admin", "wrong", ip)).toBeNull();

      let caught: (Error & { code?: number; retryMinutes?: number }) | undefined;
      try {
        auth.login("admin", "admin", ip); // even correct credentials are now blocked
      } catch (e) {
        caught = e as Error & { code?: number; retryMinutes?: number };
      }
      expect(caught).toBeDefined();
      expect(caught!.code).toBe(429);
      expect(caught!.message).toMatch(/retry/i);
    });

    it("does not lock out a different IP", () => {
      for (let i = 0; i < FAIL_LIMIT; i++) {
        auth.login("admin", "wrong", "9.9.9.9");
      }
      expect(() => auth.login("admin", "admin", "8.8.8.8")).not.toThrow();
    });

    describe("lockout window", () => {
      beforeEach(() => {
        jest.useFakeTimers();
      });
      afterEach(() => {
        jest.useRealTimers();
      });

      it("lifts the lockout once the lockout window has fully elapsed", () => {
        const ip = "9.9.9.9";
        for (let i = 0; i < FAIL_LIMIT; i++) {
          auth.login("admin", "wrong", ip);
        }
        expect(() => auth.login("admin", "admin", ip)).toThrow(/retry/i);

        jest.advanceTimersByTime(LOCK_MS + 1);

        const result = auth.login("admin", "admin", ip);
        expect(result).not.toBeNull();
        expect(result!.user.username).toBe("admin");
      });
    });
  });

  describe("changePassword", () => {
    it("clears must_change_password after a successful change", () => {
      const { token } = auth.login("admin", "admin", "1.1.1.1")!;
      expect(auth.verify(token)!.mustChangePassword).toBe(true);

      auth.changePassword(token, "admin", "admin123");

      expect(auth.verify(token)!.mustChangePassword).toBe(false);
    });

    it("the new password works afterwards and the old one no longer does", () => {
      const { token } = auth.login("admin", "admin", "1.1.1.1")!;

      auth.changePassword(token, "admin", "admin123");

      expect(auth.login("admin", "admin", "2.2.2.2")).toBeNull();
      expect(auth.login("admin", "admin123", "2.2.2.2")).not.toBeNull();
    });

    it("rejects a weak new password", () => {
      const { token } = auth.login("admin", "admin", "1.1.1.1")!;
      expect(() => auth.changePassword(token, "admin", "123")).toThrow();
    });

    it("rejects the wrong current password", () => {
      const { token } = auth.login("admin", "admin", "1.1.1.1")!;
      expect(() => auth.changePassword(token, "wrong-current", "admin123")).toThrow();
    });

    it("logs out other sessions for the same user but keeps the current one", () => {
      const a = auth.login("admin", "admin", "1.1.1.1")!;
      const b = auth.login("admin", "admin", "2.2.2.2")!;

      auth.changePassword(a.token, "admin", "admin123");

      expect(auth.verify(a.token)).not.toBeNull();
      expect(auth.verify(b.token)).toBeNull();
    });
  });
});
