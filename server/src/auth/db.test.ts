import { AuthDb, normalizeUsername } from "./db";

// Migrated + extended from scripts/selfcheck-auth.ts sections 2-4 (normalizeUsername,
// seeding, user CRUD, sessions).

const T = 1_700_000_000_000;

describe("normalizeUsername", () => {
  it("trims and lowercases", () => {
    expect(normalizeUsername("  Admin ")).toBe("admin");
  });

  it("rejects a space in the username", () => {
    expect(() => normalizeUsername("bad name")).toThrow();
  });

  it("rejects an empty username", () => {
    expect(() => normalizeUsername("")).toThrow();
  });

  it("rejects a username longer than 32 chars", () => {
    expect(() => normalizeUsername("a".repeat(33))).toThrow();
  });
});

describe("AuthDb — seeding", () => {
  let db: AuthDb;
  afterEach(() => db.close());

  it("seedDefaults on an empty DB creates admin/admin(admin) + user/user(viewer), both must-change", () => {
    db = new AuthDb(":memory:");
    db.seedDefaults(T);

    const users = db.listUsers();
    expect(users).toHaveLength(2);
    expect(users.map((u) => [u.username, u.role, u.mustChangePassword]).sort()).toEqual(
      [
        ["admin", "admin", true],
        ["user", "viewer", true],
      ].sort()
    );
    expect(db.countAdmins()).toBe(1);
  });

  it("is idempotent: calling it again on a non-empty DB does not add more users", () => {
    db = new AuthDb(":memory:");
    db.seedDefaults(T);
    db.seedDefaults(T);

    expect(db.listUsers()).toHaveLength(2);
  });
});

describe("AuthDb — user CRUD", () => {
  let db: AuthDb;
  beforeEach(() => {
    db = new AuthDb(":memory:");
  });
  afterEach(() => db.close());

  it("createUser + getByUsername/getById find the new user; PublicUser carries no password hash", () => {
    const created = db.createUser("bob", "bobpass1", "viewer", true, T);
    expect(created.username).toBe("bob");
    expect(created.role).toBe("viewer");
    expect("password_hash" in (created as object)).toBe(false);

    const byName = db.getByUsername("bob");
    expect(byName).not.toBeNull();
    expect(byName!.role).toBe("viewer");

    const byId = db.getById(byName!.id);
    expect(byId?.username).toBe("bob");
  });

  it("getByUsername/getById return null for an unknown user", () => {
    expect(db.getByUsername("nobody")).toBeNull();
    expect(db.getById(999)).toBeNull();
  });

  it("enforces username uniqueness", () => {
    db.createUser("bob", "bobpass1", "viewer", true, T);
    expect(() => db.createUser("bob", "another-pass", "viewer", true, T)).toThrow();
    // the failed insert must not have created a duplicate row
    expect(db.listUsers().filter((u) => u.username === "bob")).toHaveLength(1);
  });

  it("deleteUser removes the user", () => {
    const created = db.createUser("bob", "bobpass1", "viewer", true, T);
    expect(db.getByUsername("bob")).not.toBeNull();

    db.deleteUser(created.id);

    expect(db.getByUsername("bob")).toBeNull();
  });

  it("setPassword clears must_change_password", () => {
    const created = db.createUser("bob", "bobpass1", "viewer", true, T);
    db.setPassword(created.id, "newbobpass", false, T);
    expect(db.getById(created.id)!.must_change_password).toBe(0);
  });

  it("updateRole changes the role and countAdmins reflects it", () => {
    const created = db.createUser("bob", "bobpass1", "viewer", true, T);
    expect(db.countAdmins()).toBe(0);

    db.updateRole(created.id, "admin", T);

    expect(db.countAdmins()).toBe(1);
    expect(db.getById(created.id)!.role).toBe("admin");
  });
});

describe("AuthDb — sessions", () => {
  let db: AuthDb;
  let userId: number;
  beforeEach(() => {
    db = new AuthDb(":memory:");
    userId = db.createUser("alice", "alicepass", "admin", false, T).id;
  });
  afterEach(() => db.close());

  it("createSession + getSession finds it by token hash, joined with the owning user", () => {
    db.createSession("hashA", userId, T + 1000, T);

    const s = db.getSession("hashA");

    expect(s).not.toBeNull();
    expect(s!.userId).toBe(userId);
    expect(s!.username).toBe("alice");
    expect(s!.role).toBe("admin");
    expect(s!.mustChangePassword).toBe(false);
    expect(s!.expiresAt).toBe(T + 1000);
  });

  it("getSession returns null for an unknown token hash", () => {
    expect(db.getSession("nope")).toBeNull();
  });

  it("deleteSession removes only the targeted session", () => {
    db.createSession("hashA", userId, T + 1000, T);
    db.createSession("hashB", userId, T + 1000, T);

    db.deleteSession("hashA");

    expect(db.getSession("hashA")).toBeNull();
    expect(db.getSession("hashB")).not.toBeNull();
  });

  it("deleteSessionsForUser with an exception keeps that session and drops the rest", () => {
    db.createSession("hashA", userId, T + 1000, T);
    db.createSession("hashB", userId, T + 1000, T);

    db.deleteSessionsForUser(userId, "hashA");

    expect(db.getSession("hashA")).not.toBeNull();
    expect(db.getSession("hashB")).toBeNull();
  });

  it("deleteSessionsForUser without an exception drops all sessions for the user", () => {
    db.createSession("hashA", userId, T + 1000, T);
    db.createSession("hashB", userId, T + 1000, T);

    db.deleteSessionsForUser(userId, null);

    expect(db.getSession("hashA")).toBeNull();
    expect(db.getSession("hashB")).toBeNull();
  });

  it("pruneExpired removes sessions past their expiry", () => {
    db.createSession("hashA", userId, T + 1000, T);

    db.pruneExpired(T + 2000);

    expect(db.getSession("hashA")).toBeNull();
  });

  it("deleting the owning user cascades to delete their sessions (ON DELETE CASCADE)", () => {
    db.createSession("hashC", userId, T + 5000, T);
    expect(db.getSession("hashC")).not.toBeNull();

    db.deleteUser(userId);

    expect(db.getSession("hashC")).toBeNull();
  });
});

describe("AuthDb — api_tokens", () => {
  let db: AuthDb;
  afterEach(() => db.close());

  function freshDb(): AuthDb {
    const d = new AuthDb(":memory:");
    return d;
  }

  it("creates a token row and reads it back by hash", () => {
    db = freshDb();
    const user = db.createUser("bot", "secret1", "admin", false, T);
    const rec = db.createToken("mcp laptop", "hash-1", "inv_abcd", user.id, ["read", "write"], T, null);

    expect(rec).toMatchObject({
      name: "mcp laptop",
      prefix: "inv_abcd",
      scopes: ["read", "write"],
      createdAt: T,
      lastUsedAt: null,
      expiresAt: null,
    });

    const info = db.getToken("hash-1");
    expect(info).toMatchObject({
      tokenId: rec.id,
      name: "mcp laptop",
      userId: user.id,
      username: "bot",
      role: "admin",
      mustChangePassword: false,
      scopes: ["read", "write"],
      expiresAt: null,
    });
    expect(db.getToken("nope")).toBeNull();
  });

  it("lists tokens, deletes them, and cascades on user deletion", () => {
    db = freshDb();
    const user = db.createUser("bot", "secret1", "admin", false, T);
    const a = db.createToken("a", "hash-a", "inv_a", user.id, ["read"], T, null);
    db.createToken("b", "hash-b", "inv_b", user.id, ["read"], T + 1000, T + 9999);

    expect(db.listTokens().map((t) => t.name)).toEqual(["a", "b"]);

    db.deleteToken(a.id);
    expect(db.listTokens().map((t) => t.name)).toEqual(["b"]);

    db.deleteUser(user.id);
    expect(db.listTokens()).toEqual([]);
  });

  it("touches last_used_at and prunes expired tokens", () => {
    db = freshDb();
    const user = db.createUser("bot", "secret1", "viewer", false, T);
    db.createToken("live", "hash-live", "inv_l", user.id, ["read"], T, null);
    db.createToken("dead", "hash-dead", "inv_d", user.id, ["read"], T, T + 5000);

    db.touchToken("hash-live", T + 7000);
    expect(db.getToken("hash-live")!.lastUsedAt).toBe(T + 7000);

    db.pruneExpiredTokens(T + 6000);
    expect(db.listTokens().map((t) => t.name)).toEqual(["live"]);
  });
});
