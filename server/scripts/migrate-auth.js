// One-time auth migration: re-hash every password stored in the legacy bcrypt
// format ("$2...") to the Workers-compatible PBKDF2 format.
//
//   node server/scripts/migrate-auth.js "postgresql://user:pass@host/db?sslmode=require"
//
// NOTE: bcrypt hashes cannot be converted without the plaintext, so every
// migrated account is set to the shared demo default password
// ("password123") — the same password the login page advertises. (The
// Express login also rehashes transparently on next successful login, so
// running this script is only required before using the Cloudflare Worker.)
const cs = process.argv[2] || process.env.DATABASE_URL || "";
if (!cs) {
  console.error(
    'Usage: node server/scripts/migrate-auth.js "postgresql://user:pass@host/db?sslmode=require"\n' +
      "or set DATABASE_URL in the environment first."
  );
  process.exit(1);
}

const { connectPool, query, closeDb } = require("../src/db");
const { hashPassword } = require("../src/auth-crypto");
const DEFAULT_PASSWORD = "password123";

(async () => {
  await connectPool(cs);
  const { rows } = await query("SELECT id, email, password_hash FROM users");
  let migrated = 0;
  let skipped = 0;
  for (const row of rows) {
    if (row.password_hash && row.password_hash.startsWith("pbkdf2$")) {
      skipped++;
      continue;
    }
    await query("UPDATE users SET password_hash = $2 WHERE id = $1", [
      row.id,
      await hashPassword(DEFAULT_PASSWORD),
    ]);
    migrated++;
  }
  console.log(
    `[migrate] ${migrated} migrated to PBKDF2, ${skipped} already PBKDF2 (${rows.length} users).`
  );
  await closeDb();
})().catch((err) => {
  console.error("[migrate] Failed:", err.message);
  process.exit(1);
});
