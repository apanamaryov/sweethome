import assert from "assert";
import { hashPassword, verifyPassword, validatePassword } from "../src/auth/hash";

// ---------- 1. Хеширование паролей (scrypt) ----------
const h = hashPassword("s3cret");
assert.ok(h.startsWith("scrypt$"), "hash format has scrypt prefix");
assert.notStrictEqual(h, hashPassword("s3cret"), "разные соли → разные хеши");
assert.ok(verifyPassword("s3cret", h), "верный пароль проходит");
assert.ok(!verifyPassword("wrong", h), "неверный пароль отклонён");
assert.ok(!verifyPassword("s3cret", "garbage"), "битый формат хеша → false, без throw");
assert.throws(() => validatePassword("12345"), "пароль < 6 отклонён");
assert.doesNotThrow(() => validatePassword("123456"), "пароль ровно 6 ок");

console.log("selfcheck-auth: OK");
