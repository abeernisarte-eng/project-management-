// One-time database setup against a hosted Postgres (e.g. Neon):
//
//   node server/scripts/setup-db.js "postgresql://user:pass@host/db?sslmode=require"
//
// or export DATABASE_URL and run without arguments. Applies the schema and
// seeds demo data when the database is empty. Safe to re-run (idempotent
// CREATE IF NOT EXISTS + seed guard).
const connectionString =
  process.argv[2] || process.env.DATABASE_URL || "";

if (!connectionString) {
  console.error(
    'Usage: node server/scripts/setup-db.js "postgresql://user:pass@host/db?sslmode=require"\n' +
      "or set DATABASE_URL in the environment first."
  );
  process.exit(1);
}

const { initDb, closeDb } = require("../src/db");

initDb(connectionString)
  .then(async () => {
    console.log("[setup] Schema applied and demo data seeded (if empty).");
    await closeDb();
    console.log("[setup] Done. Deploy the app and point it at this database.");
  })
  .catch((err) => {
    console.error("[setup] Failed:", err.message);
    process.exit(1);
  });
