import fs from "fs";
import os from "os";
import path from "path";
import { Auth, bearerFromHeader } from "./service";

function freshAuth(): { auth: Auth; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auth-tokens-"));
  return { auth: new Auth(dir, 30), dir };
}

describe("bearerFromHeader", () => {
  it("extracts the token from a Bearer header and ignores anything else", () => {
    expect(bearerFromHeader("Bearer inv_abc")).toBe("inv_abc");
    expect(bearerFromHeader("bearer inv_abc")).toBe("inv_abc");
    expect(bearerFromHeader("Basic inv_abc")).toBeNull();
    expect(bearerFromHeader(undefined)).toBeNull();
    expect(bearerFromHeader("Bearer   ")).toBeNull();
  });
});

describe("Auth — API tokens", () => {
  let auth: Auth;
  let dir: string;

  beforeEach(() => {
    ({ auth, dir } = freshAuth());
  });

  afterEach(() => {
    jest.restoreAllMocks();
    auth.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function adminId(): number {
    const u = auth.db.getByUsername("admin")!;
    auth.db.setPassword(u.id, "secret1", false, Date.now()); // снять форс смены пароля
    return u.id;
  }

  it("issues a token that verifies, carries scopes and is stored hashed", () => {
    const id = adminId();
    const { token, record } = auth.issueToken("laptop", id, ["read", "write"]);

    expect(token.startsWith("inv_")).toBe(true);
    expect(record.prefix).toBe(token.slice(0, 12));
    expect(record.scopes).toEqual(["read", "write"]);

    const info = auth.verifyToken(token)!;
    expect(info.username).toBe("admin");
    expect(info.role).toBe("admin");
    expect(info.scopes).toEqual(["read", "write"]);

    // в БД лежит хеш, а не значение
    expect(auth.db.getToken(token)).toBeNull();
  });

  it("rejects unknown, malformed and expired tokens", () => {
    const id = adminId();
    expect(auth.verifyToken(null)).toBeNull();
    expect(auth.verifyToken("garbage")).toBeNull();
    expect(auth.verifyToken("inv_nonexistent")).toBeNull();

    const { token } = auth.issueToken("short-lived", id, ["read"], -1); // истёк вчера
    expect(auth.verifyToken(token)).toBeNull();
  });

  it("rejects a token whose owner must change the password", () => {
    const u = auth.db.getByUsername("user")!; // сидируется с must_change_password = 1
    const { token } = auth.issueToken("viewer bot", u.id, ["read"]);
    expect(auth.verifyToken(token)).toBeNull();
  });

  it("updates last_used_at at most once a minute", () => {
    const id = adminId();
    const { token, record } = auth.issueToken("laptop", id, ["read"]);

    const t0 = Date.now();
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(t0);
    auth.verifyToken(token);
    const first = auth.db.getTokenById(record.id)!.lastUsedAt;
    expect(first).toBe(t0);

    nowSpy.mockReturnValue(t0 + 30_000); // < минуты — не трогаем
    auth.verifyToken(token);
    expect(auth.db.getTokenById(record.id)!.lastUsedAt).toBe(first);

    nowSpy.mockReturnValue(t0 + 61_000); // > минуты — обновляем
    auth.verifyToken(token);
    expect(auth.db.getTokenById(record.id)!.lastUsedAt).toBe(t0 + 61_000);
  });

  it("lists and revokes tokens", () => {
    const id = adminId();
    const { token } = auth.issueToken("a", id, ["read"]);
    auth.issueToken("b", id, ["read", "write"]);

    expect(auth.listTokens().map((t) => t.name)).toEqual(["a", "b"]);

    auth.revokeToken(auth.listTokens()[0].id);
    expect(auth.listTokens().map((t) => t.name)).toEqual(["b"]);
    expect(auth.verifyToken(token)).toBeNull();
  });

  it("validates the token name and scopes", () => {
    const id = adminId();
    expect(() => auth.issueToken("", id, ["read"])).toThrow(/1\.\.64/);
    expect(() => auth.issueToken("a".repeat(65), id, ["read"])).toThrow(/1\.\.64/);
    expect(() => auth.issueToken("x", id, [])).toThrow(/read, write/);
    expect(() => auth.issueToken("x", 999, ["read"])).toThrow(/User not found/);
  });
});
