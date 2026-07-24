import path from "path";
import { AuthDb } from "../src/auth/db";

/**
 * Сброс пароля пользователя из CLI (для забытого пароля админа).
 * Usage: DATA_DIR=data npx tsx scripts/reset-password.ts <username> <newpass>
 * Ставит пароль и включает must_change_password (пользователь сменит при входе).
 */
function main(): void {
  const [username, newpass] = process.argv.slice(2);
  if (!username || !newpass) {
    console.error("Usage: npx tsx scripts/reset-password.ts <username> <newpass>");
    process.exit(1);
  }
  if (newpass.length < 6) {
    console.error("Password must be at least 6 characters");
    process.exit(1);
  }
  const dataDir = process.env.DATA_DIR || "data";
  const db = new AuthDb(path.join(dataDir, "auth.db"));
  const user = db.getByUsername(username.trim().toLowerCase());
  if (!user) {
    console.error(`User not found: ${username}`);
    process.exit(1);
  }
  db.setPassword(user.id, newpass, true, Date.now());
  db.deleteSessionsForUser(user.id, null);
  db.close();
  console.log(`Password reset for ${user.username}; must change on next login.`);
}

main();
