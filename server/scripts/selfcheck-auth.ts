import assert from "assert";
import { hashPassword, verifyPassword, validatePassword } from "../src/auth/hash";
import { AuthDb, normalizeUsername } from "../src/auth/db";
import { canAccess } from "../src/auth/policy";
import { Auth } from "../src/auth/service";
import fs from "fs";
import os from "os";
import path from "path";

// ---------- 1. Хеширование паролей (scrypt) ----------
const h = hashPassword("s3cret");
assert.ok(h.startsWith("scrypt$"), "hash format has scrypt prefix");
assert.notStrictEqual(h, hashPassword("s3cret"), "разные соли → разные хеши");
assert.ok(verifyPassword("s3cret", h), "верный пароль проходит");
assert.ok(!verifyPassword("wrong", h), "неверный пароль отклонён");
assert.ok(!verifyPassword("s3cret", "garbage"), "битый формат хеша → false, без throw");
assert.throws(() => validatePassword("12345"), "пароль < 6 отклонён");
assert.doesNotThrow(() => validatePassword("123456"), "пароль ровно 6 ок");

// ---------- 2. normalizeUsername ----------
assert.strictEqual(normalizeUsername("  Admin "), "admin", "trim + lowercase");
assert.throws(() => normalizeUsername("bad name"), "пробел запрещён");
assert.throws(() => normalizeUsername(""), "пустой запрещён");
assert.throws(() => normalizeUsername("a".repeat(33)), "длиннее 32 запрещён");

// ---------- 3. Сидинг и user CRUD ----------
const T = 1_700_000_000_000;
const adb = new AuthDb(":memory:");
adb.seedDefaults(T);
adb.seedDefaults(T); // идемпотентность
let users = adb.listUsers();
assert.strictEqual(users.length, 2, "сид создаёт ровно 2 пользователей");
assert.deepStrictEqual(
  users.map((u) => [u.username, u.role, u.mustChangePassword]).sort(),
  [["admin", "admin", true], ["user", "viewer", true]].sort(),
  "admin/admin(admin) + user/viewer, оба must_change"
);
assert.strictEqual(adb.countAdmins(), 1, "один админ после сида");

const created = adb.createUser("bob", "bobpass1", "viewer", true, T);
assert.strictEqual(created.username, "bob");
assert.strictEqual(adb.listUsers().length, 3);
assert.ok(!("password_hash" in (created as object)), "PublicUser без хеша");

const bob = adb.getByUsername("bob")!;
assert.ok(bob, "getByUsername находит");
adb.setPassword(bob.id, "newbobpass", false, T);
assert.strictEqual(adb.getById(bob.id)!.must_change_password, 0, "setPassword сбрасывает must_change");

adb.updateRole(bob.id, "admin", T);
assert.strictEqual(adb.countAdmins(), 2, "updateRole повышает до admin");
adb.deleteUser(bob.id);
assert.strictEqual(adb.listUsers().length, 2, "deleteUser удаляет");

// ---------- 4. Сессии (JOIN на users, каскад) ----------
const admin = adb.getByUsername("admin")!;
adb.createSession("hashA", admin.id, T + 1000, T);
const s = adb.getSession("hashA")!;
assert.strictEqual(s.username, "admin");
assert.strictEqual(s.role, "admin");
assert.strictEqual(s.mustChangePassword, true);
adb.createSession("hashB", admin.id, T + 1000, T);
adb.deleteSessionsForUser(admin.id, "hashA");
assert.ok(adb.getSession("hashA"), "текущая сессия остаётся");
assert.ok(!adb.getSession("hashB"), "прочие сессии удалены");
adb.pruneExpired(T + 2000);
assert.ok(!adb.getSession("hashA"), "истёкшая сессия убрана prune");

// каскад: удаление пользователя удаляет его сессии (ON DELETE CASCADE)
adb.createSession("hashC", admin.id, T + 5000, T);
assert.ok(adb.getSession("hashC"), "сессия создана перед удалением пользователя");
adb.deleteUser(admin.id);
assert.ok(!adb.getSession("hashC"), "ON DELETE CASCADE удалил сессию при удалении пользователя");

// ---------- 5. Матрица прав (чистая функция) ----------
assert.ok(canAccess(null, "public"), "public доступен без сессии");
assert.ok(!canAccess(null, "auth"), "auth недоступен без сессии");
assert.ok(!canAccess(null, "admin"), "admin недоступен без сессии");
assert.ok(canAccess("viewer", "auth"), "viewer видит auth-зону");
assert.ok(!canAccess("viewer", "admin"), "viewer НЕ видит admin-зону");
assert.ok(canAccess("admin", "auth"), "admin видит auth-зону");
assert.ok(canAccess("admin", "admin"), "admin видит admin-зону");

// ---------- 6. Auth: login / change-password / brute-force ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "authtest-"));
const auth = new Auth(tmp, 30);
assert.strictEqual(auth.login("admin", "wrong", "1.1.1.1"), null, "неверный пароль → null");
const ok = auth.login("admin", "admin", "1.1.1.1")!;
assert.ok(ok && ok.token, "верный логин выдаёт токен");
assert.strictEqual(ok.user.role, "admin");
assert.strictEqual(ok.user.mustChangePassword, true);
const v = auth.verify(ok.token)!;
assert.strictEqual(v.username, "admin", "verify возвращает пользователя");
// смена пароля снимает must_change и меняет пароль
auth.changePassword(ok.token, "admin", "admin123");
assert.strictEqual(auth.verify(ok.token)!.mustChangePassword, false, "must_change снят");
assert.strictEqual(auth.login("admin", "admin", "2.2.2.2"), null, "старый пароль больше не работает");
assert.ok(auth.login("admin", "admin123", "2.2.2.2"), "новый пароль работает");
assert.throws(() => auth.changePassword(ok.token, "admin123", "123"), "слабый новый пароль отклонён");
// brute-force: 5 промахов с одного IP → 429
for (let i = 0; i < 5; i++) auth.login("admin", "x", "9.9.9.9");
assert.throws(() => auth.login("admin", "admin123", "9.9.9.9"), /retry/i, "блокировка по IP");
auth.db.close();
fs.rmSync(tmp, { recursive: true, force: true });

console.log("selfcheck-auth: OK");
