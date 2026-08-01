import type { Request, Response } from "express";
import { writeSource, denyWithoutWrite, requireAdmin } from "./module";

const reqWith = (over: Partial<Request>): Request => ({ ...over }) as Request;
const resMock = () => {
  const r: { statusCode?: number; body?: unknown } = {};
  return {
    res: {
      status(c: number) { r.statusCode = c; return this; },
      json(b: unknown) { r.body = b; return this; },
    } as unknown as Response,
    r,
  };
};

describe("writeSource", () => {
  it("names UI sessions by username", () => {
    const req = reqWith({
      auth: { kind: "session", scopes: ["read", "write"] },
      user: { userId: 1, username: "alexey", role: "admin", mustChangePassword: false, expiresAt: 0 },
    });
    expect(writeSource(req)).toBe("ui:alexey");
  });
  it("names tokens by token name", () => {
    const req = reqWith({ auth: { kind: "token", scopes: ["write"], tokenName: "ha" } });
    expect(writeSource(req)).toBe("token:ha");
  });
});

describe("denyWithoutWrite", () => {
  it("denies a token without the write scope", () => {
    const { res, r } = resMock();
    const req = reqWith({ auth: { kind: "token", scopes: ["read"] } });
    expect(denyWithoutWrite(req, res)).toBe(true);
    expect(r.statusCode).toBe(403);
  });
  it("lets sessions through", () => {
    const { res } = resMock();
    const req = reqWith({ auth: { kind: "session", scopes: ["read", "write"] } });
    expect(denyWithoutWrite(req, res)).toBe(false);
  });
});

describe("requireAdmin", () => {
  it("403 for viewer, next() for admin", () => {
    const { res, r } = resMock();
    let called = 0;
    requireAdmin(
      reqWith({ user: { userId: 2, username: "v", role: "viewer", mustChangePassword: false, expiresAt: 0 } }),
      res,
      () => called++,
    );
    expect(r.statusCode).toBe(403);
    requireAdmin(
      reqWith({ user: { userId: 1, username: "a", role: "admin", mustChangePassword: false, expiresAt: 0 } }),
      res,
      () => called++,
    );
    expect(called).toBe(1);
  });
});
