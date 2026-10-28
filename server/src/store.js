// Thin async data-access layer over PostgreSQL (Neon, see db.js). Every route
// in index.js goes through here instead of writing SQL directly, so the
// queries stay in one place. All functions are async and return plain
// documents with `id` (camelCase), matching the shapes the old Mongo layer
// returned — so index.js and the frontend need no changes.
const { query } = require("./db");

function nowIso() {
  return new Date().toISOString();
}

function newId(prefix) {
  return `${prefix}${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// Postgres snake_case rows -> camelCase plain documents.
function mapUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    ...(row.password_hash !== undefined ? { passwordHash: row.password_hash } : {}),
    role: row.role,
  };
}

function mapProject(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    managerId: row.manager_id,
    memberIds: row.member_ids || [],
    startDate: row.start_date,
    endDate: row.end_date,
    status: row.status,
  };
}

function mapTask(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    assigneeId: row.assignee_id,
    status: row.status,
    priority: row.priority,
    dueDate: row.due_date,
    expectedMinutes: row.expected_minutes,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    lastUpdatedAt: row.last_updated_at,
  };
}

function mapTimelog(row) {
  if (!row) return null;
  return {
    id: row.id,
    taskId: row.task_id,
    projectId: row.project_id,
    userId: row.user_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    minutes: row.minutes,
    note: row.note,
    status: row.status || (row.ended_at ? "COMPLETED" : "RUNNING"),
    accumulatedSeconds: row.accumulated_seconds || 0,
    segmentStartedAt: row.segment_started_at,
    expectedMinutes: row.expected_minutes,
    expectedNotifiedAt: row.expected_notified_at,
  };
}

function mapUpdateRequest(row) {
  if (!row) return null;
  return {
    id: row.id,
    taskId: row.task_id,
    developerId: row.developer_id,
    dueAt: row.due_at,
    note: row.note,
    status: row.status,
    createdAt: row.created_at,
    fulfilledAt: row.fulfilled_at,
    notifiedAt: row.notified_at,
  };
}

function mapPersonalReminder(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    note: row.note,
    dueAt: row.due_at,
    done: row.done,
    notifiedAt: row.notified_at,
    createdAt: row.created_at,
  };
}

function mapIdleReminder(row) {
  if (!row) return null;
  return {
    id: row.id,
    taskId: row.task_id,
    taskTitle: row.task_title,
    projectId: row.project_id,
    projectName: row.project_name,
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    lastActivityTime: row.last_activity_time,
    status: row.status,
    reason: row.reason,
    createdAt: row.created_at,
    resolved: row.resolved,
    resolvedAt: row.resolved_at,
  };
}

// ---------- users ----------
const users = {
  list: async () =>
    (await query("SELECT id, name, email, role FROM users ORDER BY name")).rows.map(mapUser),
  findById: async (id) =>
    mapUser(
      (
        await query("SELECT id, name, email, role FROM users WHERE id = $1", [id])
      ).rows[0]
    ),
  findByEmailWithPassword: async (email) =>
    mapUser(
      (
        await query("SELECT * FROM users WHERE email = $1", [
          String(email).toLowerCase(),
        ])
      ).rows[0]
    ),
  updatePasswordHash: async (id, passwordHash) => {
    await query("UPDATE users SET password_hash = $2 WHERE id = $1", [
      id,
      passwordHash,
    ]);
  },
};

// ---------- projects ----------
const projects = {
  list: async () => (await query("SELECT * FROM projects ORDER BY name")).rows.map(mapProject),
  findById: async (id) =>
    mapProject((await query("SELECT * FROM projects WHERE id = $1", [id])).rows[0]),
  members: async (projectId) => {
    const p = await projects.findById(projectId);
    return p ? p.memberIds : [];
  },
  isMember: async (projectId, userId) => {
    const p = await projects.findById(projectId);
    return Boolean(p && p.memberIds.includes(userId));
  },
  create: async ({ name, description, managerId, startDate, endDate, memberIds }) => {
    const id = newId("p");
    await query(
      `INSERT INTO projects (id, name, description, manager_id, member_ids, start_date, end_date, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        name,
        description || "",
        managerId,
        memberIds || [],
        startDate || null,
        endDate || null,
        "IN_PROGRESS",
      ]
    );
    return projects.findById(id);
  },
};

// ---------- tasks ----------
const tasks = {
  list: async () =>
    (await query("SELECT * FROM tasks ORDER BY last_updated_at DESC")).rows.map(mapTask),
  findById: async (id) =>
    mapTask((await query("SELECT * FROM tasks WHERE id = $1", [id])).rows[0]),
  create: async ({ projectId, title, description, assigneeId, priority, dueDate, expectedMinutes }) => {
    const id = newId("t");
    const now = nowIso();
    await query(
      `INSERT INTO tasks (id, project_id, title, description, assignee_id, status, priority, due_date, expected_minutes, created_at, last_updated_at)
       VALUES ($1, $2, $3, $4, $5, 'TODO', $6, $7, $8, $9, $9)`,
      [id, projectId, title, description || "", assigneeId || null, priority || "MEDIUM", dueDate || null, expectedMinutes ?? null, now]
    );
    return tasks.findById(id);
  },
  update: async (id, patch) => {
    const task = await tasks.findById(id);
    if (!task) return null;
    await query(
      `UPDATE tasks SET
         title = $2,
         description = $3,
         assignee_id = $4,
         status = $5,
         priority = $6,
         due_date = $7,
         expected_minutes = $8,
         completed_at = $9,
         last_updated_at = now()
       WHERE id = $1`,
      [
        id,
        patch.title ?? task.title,
        patch.description ?? task.description,
        patch.assigneeId !== undefined ? patch.assigneeId : task.assigneeId,
        patch.status ?? task.status,
        patch.priority ?? task.priority,
        patch.dueDate !== undefined ? patch.dueDate : task.dueDate,
        patch.expectedMinutes !== undefined ? patch.expectedMinutes : task.expectedMinutes,
        patch.completedAt !== undefined ? patch.completedAt : task.completedAt,
      ]
    );
    return tasks.findById(id);
  },
  // Mark a task completed: DONE status + completion timestamp in one write.
  complete: async (id) => {
    await query(
      "UPDATE tasks SET status = 'DONE', completed_at = $2, last_updated_at = $2 WHERE id = $1",
      [id, nowIso()]
    );
    return tasks.findById(id);
  },
  touch: async (id, when) => {
    await query("UPDATE tasks SET last_updated_at = $2 WHERE id = $1", [
      id,
      when || nowIso(),
    ]);
  },
};

// ---------- timelogs ----------
// Multi-entry time tracking: many rows can be open at once, and every row is
// an independent tracker with its own lifecycle (start → pause/resume → stop).
// Running time = accumulated_seconds (banked from paused segments) plus the
// current segment (now − segment_started_at).
const timelogs = {
  list: async () => (await query("SELECT * FROM timelogs ORDER BY started_at")).rows.map(mapTimelog),
  findById: async (id) =>
    mapTimelog((await query("SELECT * FROM timelogs WHERE id = $1", [id])).rows[0]),
  start: async ({ taskId, projectId, userId, note, expectedMinutes }) => {
    const id = newId("tl");
    const now = nowIso();
    await query(
      `INSERT INTO timelogs
         (id, task_id, project_id, user_id, started_at, ended_at, minutes, note,
          status, accumulated_seconds, segment_started_at, expected_minutes)
       VALUES ($1, $2, $3, $4, $5, NULL, NULL, $6, 'RUNNING', 0, $5, $7)`,
      [id, taskId || null, projectId || null, userId, now, note || "", expectedMinutes ?? null]
    );
    return timelogs.findById(id);
  },
  // Business-rule guards for the PM workflow: one running session per task
  // and one per developer at a time. Other entries are untouched.
  findRunningByTask: async (taskId) =>
    mapTimelog(
      (
        await query(
          "SELECT * FROM timelogs WHERE task_id = $1 AND status = 'RUNNING' LIMIT 1",
          [taskId]
        )
      ).rows[0]
    ),
  findRunningByDeveloper: async (userId) =>
    mapTimelog(
      (
        await query(
          "SELECT * FROM timelogs WHERE user_id = $1 AND status = 'RUNNING' LIMIT 1",
          [userId]
        )
      ).rows[0]
    ),
  // Every not-yet-stopped session of a task (running or paused) — used when
  // completing a task so no tracker is left dangling.
  findAllOpenByTask: async (taskId) =>
    (
      await query(
        "SELECT * FROM timelogs WHERE task_id = $1 AND ended_at IS NULL",
        [taskId]
      )
    ).rows.map(mapTimelog),
  // Set (or re-arm) the expected-duration threshold. Clears the notified flag
  // so the "expected time reached" alert can fire once for the new threshold.
  setExpected: async (id, minutes) => {
    await query(
      "UPDATE timelogs SET expected_minutes = $2, expected_notified_at = NULL WHERE id = $1",
      [id, minutes]
    );
    return timelogs.findById(id);
  },
  markExpectedNotified: async (id, when) => {
    await query(
      "UPDATE timelogs SET expected_notified_at = $2 WHERE id = $1 AND expected_notified_at IS NULL",
      [id, when]
    );
  },
  // Bank the current segment and freeze the entry without ending it. Only a
  // RUNNING entry can pause — every other entry is untouched.
  pause: async (id) => {
    const log = await timelogs.findById(id);
    if (!log || log.status !== "RUNNING") return null;
    const banked =
      log.accumulatedSeconds +
      Math.max(
        0,
        Math.floor((Date.now() - new Date(log.segmentStartedAt).getTime()) / 1000)
      );
    await query(
      "UPDATE timelogs SET status = 'PAUSED', accumulated_seconds = $2, segment_started_at = NULL WHERE id = $1",
      [id, banked]
    );
    return timelogs.findById(id);
  },
  // Start a fresh running segment; banked time is kept.
  resume: async (id) => {
    const log = await timelogs.findById(id);
    if (!log || log.status !== "PAUSED") return null;
    await query(
      "UPDATE timelogs SET status = 'RUNNING', segment_started_at = $2 WHERE id = $1",
      [id, nowIso()]
    );
    return timelogs.findById(id);
  },
  stop: async (id, note) => {
    const log = await timelogs.findById(id);
    if (!log) return null;
    const now = Date.now();
    const segmentSeconds = log.segmentStartedAt
      ? Math.max(0, Math.floor((now - new Date(log.segmentStartedAt).getTime()) / 1000))
      : 0;
    const totalSeconds = log.accumulatedSeconds + segmentSeconds;
    await query(
      `UPDATE timelogs
         SET ended_at = $2, minutes = $3, note = $4,
             status = 'COMPLETED', segment_started_at = NULL, accumulated_seconds = $5
       WHERE id = $1`,
      [
        id,
        new Date(now).toISOString(),
        Math.floor(totalSeconds / 60),
        note || log.note,
        totalSeconds,
      ]
    );
    return timelogs.findById(id);
  },
  // Edit an entry: `note` works on any entry; `startedAt` + `endedAt` (both
  // required together) recompute the duration of a completed one — manual
  // times override the pause math.
  update: async (id, { note, startedAt, endedAt }) => {
    const log = await timelogs.findById(id);
    if (!log) return null;
    const nextNote = note !== undefined ? note : log.note;
    if (startedAt && endedAt) {
      const minutes = Math.max(
        0,
        Math.floor((new Date(endedAt) - new Date(startedAt)) / 60000)
      );
      await query(
        `UPDATE timelogs
           SET note = $2, started_at = $3, ended_at = $4,
               minutes = $5, accumulated_seconds = $6
         WHERE id = $1`,
        [id, nextNote, startedAt, endedAt, minutes, minutes * 60]
      );
    } else {
      await query("UPDATE timelogs SET note = $2 WHERE id = $1", [id, nextNote]);
    }
    return timelogs.findById(id);
  },
  remove: async (id) => {
    await query("DELETE FROM timelogs WHERE id = $1", [id]);
  },
};

// ---------- update requests ----------
const updateRequests = {
  list: async () =>
    (await query("SELECT * FROM update_requests ORDER BY due_at")).rows.map(mapUpdateRequest),
  findById: async (id) =>
    mapUpdateRequest(
      (await query("SELECT * FROM update_requests WHERE id = $1", [id])).rows[0]
    ),
  create: async ({ taskId, developerId, dueAt, note }) => {
    const id = newId("ur");
    await query(
      `INSERT INTO update_requests (id, task_id, developer_id, due_at, note, status, created_at, fulfilled_at, notified_at)
       VALUES ($1, $2, $3, $4, $5, 'PENDING', $6, NULL, NULL)`,
      [id, taskId, developerId, dueAt, note || "", nowIso()]
    );
    return updateRequests.findById(id);
  },
  fulfill: async (id) => {
    await query(
      "UPDATE update_requests SET status = 'FULFILLED', fulfilled_at = $2 WHERE id = $1",
      [id, nowIso()]
    );
    return updateRequests.findById(id);
  },
  markNotified: async (id, when) => {
    await query(
      "UPDATE update_requests SET notified_at = $2 WHERE id = $1 AND notified_at IS NULL",
      [id, when]
    );
  },
};

// ---------- personal reminders ----------
const personalReminders = {
  listForUser: async (userId) =>
    (
      await query(
        "SELECT * FROM personal_reminders WHERE user_id = $1 ORDER BY due_at",
        [userId]
      )
    ).rows.map(mapPersonalReminder),
  findById: async (id) =>
    mapPersonalReminder(
      (await query("SELECT * FROM personal_reminders WHERE id = $1", [id])).rows[0]
    ),
  create: async ({ userId, title, note, dueAt }) => {
    const id = newId("pr");
    await query(
      `INSERT INTO personal_reminders (id, user_id, title, note, due_at, done, notified_at, created_at)
       VALUES ($1, $2, $3, $4, $5, false, NULL, $6)`,
      [id, userId, title, note || "", dueAt, nowIso()]
    );
    return personalReminders.findById(id);
  },
  setDone: async (id, done) => {
    await query("UPDATE personal_reminders SET done = $2 WHERE id = $1", [
      id,
      Boolean(done),
    ]);
    return personalReminders.findById(id);
  },
  markNotified: async (id, when) => {
    await query(
      "UPDATE personal_reminders SET notified_at = $2 WHERE id = $1 AND notified_at IS NULL",
      [id, when]
    );
  },
};

// ---------- idle task reminders ----------
const idleReminders = {
  list: async () =>
    (await query("SELECT * FROM idle_reminders ORDER BY created_at DESC")).rows.map(mapIdleReminder),
  hasUnresolvedForTask: async (taskId) => {
    const { rows } = await query(
      "SELECT 1 FROM idle_reminders WHERE task_id = $1 AND resolved = false LIMIT 1",
      [taskId]
    );
    return rows.length > 0;
  },
  create: async (reminder) => {
    await query(
      `INSERT INTO idle_reminders
         (id, task_id, task_title, project_id, project_name, employee_id, employee_name,
          last_activity_time, status, reason, created_at, resolved, resolved_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, false, NULL)`,
      [
        reminder.id,
        reminder.taskId,
        reminder.taskTitle,
        reminder.projectId || null,
        reminder.projectName || null,
        reminder.employeeId || null,
        reminder.employeeName || null,
        reminder.lastActivityTime || null,
        reminder.status,
        reminder.reason || "",
        reminder.createdAt || nowIso(),
      ]
    );
    return idleReminders.findById(reminder.id);
  },
  findById: async (id) =>
    mapIdleReminder(
      (await query("SELECT * FROM idle_reminders WHERE id = $1", [id])).rows[0]
    ),
  setResolved: async (id, resolved) => {
    await query(
      "UPDATE idle_reminders SET resolved = $2, resolved_at = $3 WHERE id = $1",
      [id, Boolean(resolved), resolved ? nowIso() : null]
    );
    return idleReminders.findById(id);
  },
};

// ---------- user settings (notifications tab) ----------
// Preferences live as a JSON blob per user; the API merges them over
// DEFAULT_NOTIFICATION_SETTINGS so partial payloads and new keys stay safe.
const DEFAULT_NOTIFICATION_SETTINGS = {
  masterEnabled: true,
  categories: {
    expectedTime: true,
    trackingActivity: true,
    taskUpdates: true,
    taskDeadlines: true,
    reminders: true,
  },
  sound: { enabled: true, tone: "chime", volume: 60, customAudio: null },
};

function mergeSettings(stored) {
  const d = DEFAULT_NOTIFICATION_SETTINGS;
  const s = stored || {};
  return {
    masterEnabled: typeof s.masterEnabled === "boolean" ? s.masterEnabled : d.masterEnabled,
    categories: { ...d.categories, ...(s.categories || {}) },
    sound: { ...d.sound, ...(s.sound || {}) },
  };
}

const userSettings = {
  defaults: DEFAULT_NOTIFICATION_SETTINGS,
  get: async (userId) => {
    const { rows } = await query("SELECT data FROM user_settings WHERE user_id = $1", [userId]);
    return mergeSettings(rows[0] ? rows[0].data : null);
  },
  upsert: async (userId, data) => {
    await query(
      `INSERT INTO user_settings (user_id, data, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (user_id) DO UPDATE SET data = $2, updated_at = now()`,
      [userId, JSON.stringify(data)]
    );
    return userSettings.get(userId);
  },
};

// ---------- activity events (tracking changes, task updates, deadlines) ----------
const activityEvents = {
  // dedupKey: when provided (e.g. one deadline reminder per task per day), a
  // repeat within the window is silently dropped instead of re-inserted.
  create: async ({ userId, kind, title, body, taskId, dedupKey }) => {
    if (dedupKey) {
      const { rows } = await query(
        "SELECT 1 FROM activity_events WHERE user_id = $1 AND dedup_key = $2 LIMIT 1",
        [userId, dedupKey]
      );
      if (rows.length > 0) return null;
    }
    const id = newId("ev");
    await query(
      `INSERT INTO activity_events (id, user_id, kind, title, body, task_id, dedup_key, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, userId, kind, title, body || "", taskId || null, dedupKey || null, nowIso()]
    );
    return activityEvents.findById(id);
  },
  findById: async (id) => {
    const { rows } = await query("SELECT * FROM activity_events WHERE id = $1", [id]);
    if (!rows[0]) return null;
    return {
      id: rows[0].id,
      userId: rows[0].user_id,
      kind: rows[0].kind,
      title: rows[0].title,
      body: rows[0].body,
      taskId: rows[0].task_id,
      createdAt: rows[0].created_at,
    };
  },
  // Unseen events of the last 24h — old ones are never flushed at the user.
  listUnseen: async (userId) =>
    (
      await query(
        `SELECT * FROM activity_events
          WHERE user_id = $1 AND notified_at IS NULL AND created_at > now() - interval '24 hours'
          ORDER BY created_at DESC
          LIMIT 20`,
        [userId]
      )
    ).rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      kind: row.kind,
      title: row.title,
      body: row.body,
      taskId: row.task_id,
      createdAt: row.created_at,
    })),
  markNotified: async (ids, when) => {
    if (!ids.length) return;
    await query(
      "UPDATE activity_events SET notified_at = $2 WHERE id = ANY($1)",
      [ids, when]
    );
  },
};

module.exports = {
  nowIso,
  newId,
  users,
  projects,
  tasks,
  timelogs,
  updateRequests,
  personalReminders,
  idleReminders,
  userSettings,
  activityEvents,
};
