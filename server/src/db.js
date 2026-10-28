// PostgreSQL (Neon) connection + schema + one-time seed. Used by store.js
// (and transitively by every route).
//
// The connection string comes from DATABASE_URL, loaded from server/.env (see
// the --env-file-if-exists flag in server/package.json scripts, or export it
// yourself). Neon URLs look like:
//   postgresql://user:password@ep-xxx-pooler.region.aws.neon.tech/neondb?sslmode=require
//
// The old embedded MongoDB is gone: data now lives entirely in Postgres. The
// previous Mongo contents were dumped to server/src/data/mongo-dump.json and
// seed/migrate from there (see migrate.js).
const { Pool } = require("pg");
const { hashPassword } = require("./auth-crypto");

const DATABASE_URL = process.env.DATABASE_URL || "";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  manager_id  TEXT NOT NULL,
  member_ids  TEXT[] NOT NULL DEFAULT '{}',
  start_date  TEXT,
  end_date    TEXT,
  status      TEXT NOT NULL DEFAULT 'IN_PROGRESS'
);

CREATE TABLE IF NOT EXISTS tasks (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL,
  title           TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  assignee_id     TEXT,
  status          TEXT NOT NULL DEFAULT 'TODO',
  priority        TEXT NOT NULL DEFAULT 'MEDIUM',
  due_date        TEXT,
  expected_minutes INTEGER,
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS timelogs (
  id                  TEXT PRIMARY KEY,
  task_id             TEXT,
  project_id          TEXT,
  user_id             TEXT NOT NULL,
  started_at          TIMESTAMPTZ NOT NULL,
  ended_at            TIMESTAMPTZ,
  minutes             INTEGER,
  note                TEXT NOT NULL DEFAULT '',
  status              TEXT,
  accumulated_seconds INTEGER NOT NULL DEFAULT 0,
  segment_started_at  TIMESTAMPTZ
);

-- Multi-entry time tracking: three columns added to existing installations.
-- status: RUNNING | PAUSED | COMPLETED. accumulated_seconds banks time from
-- paused segments; segment_started_at is the start of the current running
-- segment (NULL while paused or completed). The UPDATEs backfill legacy rows
-- once (status IS NULL guard makes re-runs no-ops).
ALTER TABLE timelogs ADD COLUMN IF NOT EXISTS status TEXT;
ALTER TABLE timelogs ADD COLUMN IF NOT EXISTS accumulated_seconds INTEGER NOT NULL DEFAULT 0;
ALTER TABLE timelogs ADD COLUMN IF NOT EXISTS segment_started_at TIMESTAMPTZ;

UPDATE timelogs SET status = 'COMPLETED', accumulated_seconds = COALESCE(minutes, 0) * 60
  WHERE ended_at IS NOT NULL AND status IS NULL;
UPDATE timelogs SET status = 'RUNNING', segment_started_at = started_at
  WHERE ended_at IS NULL AND status IS NULL;

-- PM-controlled time tracking: expected durations (per task and per session,
-- session overrides task) and the completion timestamp for tasks.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS expected_minutes INTEGER;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE timelogs ADD COLUMN IF NOT EXISTS expected_minutes INTEGER;
ALTER TABLE timelogs ADD COLUMN IF NOT EXISTS expected_notified_at TIMESTAMPTZ;

-- Settings tab: per-user notification preferences (JSON blob validated by
-- the API; server-side defaults fill anything missing) and the event stream
-- that backs activity notifications (tracking changes, task updates,
-- deadline reminders).
CREATE TABLE IF NOT EXISTS user_settings (
  user_id    TEXT PRIMARY KEY,
  data       JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS activity_events (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  task_id     TEXT,
  dedup_key   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  notified_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS update_requests (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL,
  developer_id TEXT NOT NULL,
  due_at       TIMESTAMPTZ NOT NULL,
  note         TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'PENDING',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  fulfilled_at TIMESTAMPTZ,
  notified_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS personal_reminders (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  title       TEXT NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  due_at      TIMESTAMPTZ NOT NULL,
  done        BOOLEAN NOT NULL DEFAULT false,
  notified_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS idle_reminders (
  id                 TEXT PRIMARY KEY,
  task_id            TEXT NOT NULL,
  task_title         TEXT NOT NULL,
  project_id         TEXT,
  project_name       TEXT,
  employee_id        TEXT,
  employee_name      TEXT,
  last_activity_time TIMESTAMPTZ,
  status             TEXT NOT NULL,
  reason             TEXT NOT NULL DEFAULT '',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved           BOOLEAN NOT NULL DEFAULT false,
  resolved_at        TIMESTAMPTZ
);
`;

const DEFAULT_PASSWORD = "password123";

let pool = null;

function getDb() {
  if (!pool) throw new Error("Database not initialized — call initDb() first");
  return pool;
}

// Convenience wrapper so store.js never touches the Pool object directly.
async function query(text, params) {
  return getDb().query(text, params);
}

async function seedIfEmpty() {
  const { rows } = await query("SELECT count(*)::int AS n FROM users");
  if (rows[0].n > 0) return;

  const dump = require("./data/mongo-dump.json");
  const users = dump.users.length
    ? dump.users
    : require("./data/users.json");
  const projects = dump.projects.length
    ? dump.projects
    : require("./data/projects.json");
  const tasks = dump.tasks;
  const timelogs = dump.timelogs;
  const updateRequests = dump.updateRequests;
  const personalReminders = dump.personalReminders;
  const idleReminders = dump.idleReminders;

  for (const u of users) {
    // PBKDF2 (Web Crypto) hashes only — bcrypt cannot be verified in the
    // Cloudflare Worker, and the demo accounts share the default password.
    const hash = await hashPassword(DEFAULT_PASSWORD);
    await query(
      `INSERT INTO users (id, name, email, password_hash, role)
       VALUES ($1, $2, $3, $4, $5)`,
      [u.id, u.name, u.email.toLowerCase(), hash, u.role]
    );
  }

  for (const p of projects) {
    await query(
      `INSERT INTO projects (id, name, description, manager_id, member_ids, start_date, end_date, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        p.id,
        p.name,
        p.description || "",
        p.managerId,
        p.memberIds || [],
        p.startDate || null,
        p.endDate || null,
        p.status || "IN_PROGRESS",
      ]
    );
  }

  for (const t of tasks) {
    await query(
      `INSERT INTO tasks (id, project_id, title, description, assignee_id, status, priority, due_date, created_at, last_updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        t.id,
        t.projectId,
        t.title,
        t.description || "",
        t.assigneeId || null,
        t.status,
        t.priority,
        t.dueDate || null,
        t.createdAt,
        t.lastUpdatedAt,
      ]
    );
  }

  for (const l of timelogs) {
    await query(
      `INSERT INTO timelogs (id, task_id, project_id, user_id, started_at, ended_at, minutes, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        l.id,
        l.taskId || null,
        l.projectId || null,
        l.userId,
        l.startedAt,
        l.endedAt || null,
        l.minutes == null ? null : l.minutes,
        l.note || "",
      ]
    );
  }

  for (const ur of updateRequests) {
    await query(
      `INSERT INTO update_requests (id, task_id, developer_id, due_at, note, status, created_at, fulfilled_at, notified_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        ur.id,
        ur.taskId,
        ur.developerId,
        ur.dueAt,
        ur.note || "",
        ur.status || "PENDING",
        ur.createdAt,
        ur.fulfilledAt || null,
        ur.notifiedAt || null,
      ]
    );
  }

  for (const pr of personalReminders) {
    await query(
      `INSERT INTO personal_reminders (id, user_id, title, note, due_at, done, notified_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        pr.id,
        pr.userId,
        pr.title,
        pr.note || "",
        pr.dueAt,
        Boolean(pr.done),
        pr.notifiedAt || null,
        pr.createdAt,
      ]
    );
  }

  for (const r of idleReminders) {
    await query(
      `INSERT INTO idle_reminders (id, task_id, task_title, project_id, project_name, employee_id, employee_name, last_activity_time, status, reason, created_at, resolved, resolved_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        r.id,
        r.taskId,
        r.taskTitle,
        r.projectId || null,
        r.projectName || null,
        r.employeeId || null,
        r.employeeName || null,
        r.lastActivityTime || null,
        r.status,
        r.reason || "",
        r.createdAt,
        Boolean(r.resolved),
        r.resolvedAt || null,
      ]
    );
  }

  console.log(
    `[db] Seeded ${users.length} users, ${projects.length} projects, ${tasks.length} tasks, ` +
      `${timelogs.length} time logs, ${idleReminders.length} idle reminders into Postgres.`
  );
  console.log(
    `[db] Users without a stored hash got the default password "${DEFAULT_PASSWORD}".`
  );
}

// Connect a pool (Workers/Pages entry point: the connection string comes
// from the Hyperdrive binding or the environment at request time). No schema
// or seeding here — call initDb() when migration + seed are wanted.
async function connectPool(connectionString) {
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Put your Neon connection string in server/.env" +
        " as DATABASE_URL=postgresql://... or export it before starting."
    );
  }

  pool = new Pool({
    connectionString,
    // Neon requires TLS; the URL's sslmode=require covers it, but be explicit
    // so a URL without sslmode still works.
    ssl: connectionString.includes("sslmode=")
      ? undefined
      : { rejectUnauthorized: false },
  });

  const info = await pool.query("SELECT version()");
  console.log(`[db] Connected to Postgres: ${info.rows[0].version.split(",")[0]}`);
  return pool;
}

// Full init for the long-running Express server: connect + migrate + seed.
async function initDb(connectionString) {
  await connectPool(connectionString || DATABASE_URL);
  await pool.query(SCHEMA);
  await seedIfEmpty();
  return pool;
}

async function closeDb() {
  if (pool) await pool.end();
  pool = null;
}

module.exports = {
  initDb,
  connectPool,
  getDb,
  query,
  closeDb,
  SCHEMA,
  DEFAULT_PASSWORD,
};
