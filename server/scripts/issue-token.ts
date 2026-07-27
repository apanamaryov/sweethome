import { Auth } from "../src/auth/service";
import type { TokenScope } from "@inverter/shared";

/**
 * Выдача API-токена из CLI (первый токен для MCP, когда UI ещё не под рукой).
 * Usage: DATA_DIR=data npx tsx scripts/issue-token.ts <name> [--write] [--days N] [--user admin]
 * Значение токена печатается один раз — в БД хранится только его sha256.
 */
function main(): void {
  const argv = process.argv.slice(2);
  // Позиционный аргумент — первый, который не флаг и не значение флага с параметром.
  const name = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--days" && argv[i - 1] !== "--user");
  if (!name) {
    console.error("Usage: npx tsx scripts/issue-token.ts <name> [--write] [--days N] [--user admin]");
    process.exit(1);
  }
  const scopes: TokenScope[] = argv.includes("--write") ? ["read", "write"] : ["read"];
  const daysArg = argv.indexOf("--days");
  const days = daysArg === -1 ? undefined : Number(argv[daysArg + 1]);
  if (daysArg !== -1 && (!Number.isFinite(days) || (days as number) <= 0)) {
    console.error("--days expects a positive number");
    process.exit(1);
  }
  const userArg = argv.indexOf("--user");
  const username = userArg === -1 ? "admin" : String(argv[userArg + 1] ?? "");

  const auth = new Auth(process.env.DATA_DIR || "data", 30);
  const user = auth.db.getByUsername(username.trim().toLowerCase());
  if (!user) {
    console.error(`User not found: ${username}`);
    process.exit(1);
  }
  if (user.must_change_password) {
    console.error(
      `User ${user.username} must change the password first — tokens of such users are rejected.`
    );
    process.exit(1);
  }
  const { token, record } = auth.issueToken(name, user.id, scopes, days);
  auth.db.close();

  console.log(`Token "${record.name}" for ${user.username} (${scopes.join(", ")}):`);
  console.log(token);
  console.log(record.expiresAt ? `Expires: ${new Date(record.expiresAt).toISOString()}` : "Never expires.");
  console.log("Store it now — it is not recoverable.");
}

main();
