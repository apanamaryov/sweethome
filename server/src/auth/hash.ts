import crypto from "crypto";

/** Минимальная длина пароля при смене/создании. */
export const MIN_PASSWORD_LEN = 6;

const KEYLEN = 32;
const SALT_BYTES = 16;

/** Хеш пароля scrypt в формате "scrypt$<saltHex>$<hashHex>". */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(SALT_BYTES);
  const hash = crypto.scryptSync(password, salt, KEYLEN);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

/** Проверка пароля против сохранённого хеша. Битый формат → false (без throw). */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1], "hex");
  const expected = Buffer.from(parts[2], "hex");
  if (salt.length === 0 || expected.length !== KEYLEN) return false;
  const actual = crypto.scryptSync(password, salt, KEYLEN);
  return crypto.timingSafeEqual(actual, expected);
}

/** Валидация нового пароля. Бросает Error при нарушении политики. */
export function validatePassword(password: string): void {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LEN) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LEN} characters`);
  }
}
