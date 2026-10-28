// Cloudflare Workers/Pages entry point for the SPTTS API — a Hono port of
// the Express server (server/src/index.js). Same routes, same validation,
// same store layer (server/src/store.js); only the HTTP plumbing differs.
//
// Database access: the connection string comes from the HYPERDRIVE binding
// (recommended in production — Cloudflare pools the connections) or falls
// back to a DATABASE_URL secret. Schema + seed are NOT run here; apply them
// once with server/scripts/setup-db.js.
//
// Local development: npx wrangler pages dev (reads .dev.vars for DATABASE_URL).
const { Hono } = require("hono");
const jwt = require("jsonwebtoken");
const { verifyPassword } = require("./_lib/auth-crypto");
const {
  users,
  projects,
  tasks,
  timelogs,
  updateRequests,
  personalReminders,
  idleReminders,
  userSettings,
  activityEvents,
  nowIso,
} = require("./_lib/store");
const { connectPool, closeDb } = require("./_lib/db");

// The pool is created once per isolate for a given connection string; with
// Hyperdrive in front, connection reuse is handled by Cloudflare.
// Per-request pool lifecycle: node-postgres pools break when their idle
// sockets are reused across requests in workerd, and Hyperdrive does the
// connection pooling for us — so every request gets a fresh pool that is
// closed when the response is done.
async function ensureDb(env) {
  const cs =
    (env.HYPERDRIVE && env.HYPERDRIVE.connectionString) || env.DATABASE_URL;
  if (!cs) {
    throw new Error(
      "No database configured — set the HYPERDRIVE binding or DATABASE_URL"
    );
  }
  await connectPool(cs);
}

// Same validation as the Express settings route: merge partial payloads over
// defaults and never let a bad client corrupt the stored blob.
function validateSettingsPayload(body) {
  const errors = [];
  const out = {};
  if (body.masterEnabled !== undefined) {
    if (typeof body.masterEnabled !== "boolean")
      errors.push("masterEnabled must be a boolean");
    else out.masterEnabled = body.masterEnabled;
  }
  if (body.categories !== undefined) {
    if (typeof body.categories !== "object" || body.categories === null) {
      errors.push("categories must be an object");
    } else {
      const allowed = [
        "expectedTime",
        "trackingActivity",
        "taskUpdates",
        "taskDeadlines",
        "reminders",
      ];
      const cats = {};
      for (const key of allowed) {
        if (body.categories[key] !== undefined) {
          if (typeof body.categories[key] !== "boolean")
            errors.push(`categories.${key} must be a boolean`);
          else cats[key] = body.categories[key];
        }
      }
      out.categories = cats;
    }
  }
  if (body.sound !== undefined) {
    if (typeof body.sound !== "object" || body.sound === null) {
      errors.push("sound must be an object");
    } else {
      const sound = {};
      if (body.sound.enabled !== undefined) {
        if (typeof body.sound.enabled !== "boolean")
          errors.push("sound.enabled must be a boolean");
        else sound.enabled = body.sound.enabled;
      }
      if (body.sound.tone !== undefined) {
        if (typeof body.sound.tone !== "string" || body.sound.tone.length > 40)
          errors.push("sound.tone must be a short string");
        else sound.tone = body.sound.tone;
      }
      if (body.sound.volume !== undefined) {
        const v = Number(body.sound.volume);
        if (!Number.isFinite(v) || v < 0 || v > 100)
          errors.push("sound.volume must be 0-100");
        else sound.volume = Math.round(v);
      }
      if (body.sound.customAudio !== undefined) {
        if (body.sound.customAudio === null) {
          sound.customAudio = null;
        } else if (
          typeof body.sound.customAudio !== "string" ||
          !body.sound.customAudio.startsWith("data:audio/")
        ) {
          errors.push("sound.customAudio must be a data:audio/ URL or null");
        } else if (body.sound.customAudio.length > 600000) {
          errors.push("sound.customAudio is too large (max ~450KB file)");
        } else {
          sound.customAudio = body.sound.customAudio;
        }
      }
      out.sound = sound;
    }
  }
  return { errors, out };
}

function createApp(env) {
  const JWT_SECRET = env.JWT_SECRET || "sptts-dev-secret-change-me";
  const app = new Hono();

  // Database connectivity on every request: fresh pool per request, closed
  // after the response (Hyperdrive pools the actual DB connections).
  app.use("*", async (c, next) => {
    await ensureDb(c.env || env);
    try {
      await next();
    } finally {
      await closeDb();
    }
  });

  async function body(c) {
    return (await c.req.json().catch(() => ({}))) || {};
  }

  // ---------- Auth ----------
  app.get("/api/health", (c) => c.json({ status: "ok" }));

  app.post("/api/auth/login", async (c) => {
    const { email, password } = await body(c);
    if (!email || !password) {
      return c.json({ error: "email and password are required" }, 400);
    }
    const row = await users.findByEmailWithPassword(email);
    if (!row) return c.json({ error: "Invalid email or password" }, 401);
    const ok = await verifyPassword(password, row.passwordHash);
    if (ok !== true) return c.json({ error: "Invalid email or password" }, 401);
    const user = { id: row.id, name: row.name, email: row.email, role: row.role };
    const token = jwt.sign(
      { sub: user.id, role: user.role },
      JWT_SECRET,
      { expiresIn: "12h" }
    );
    return c.json({ user, token });
  });


  // Everything below requires a valid session.
  app.use("/api/*", async (c, next) => {
    const header = c.req.header("Authorization") || "";
    const [scheme, token] = header.split(" ");
    if (scheme !== "Bearer" || !token) {
      return c.json({ error: "Missing or invalid Authorization header" }, 401);
    }
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      const user = await users.findById(payload.sub);
      if (!user) return c.json({ error: "User no longer exists" }, 401);
      c.set("user", user);
      await next();
    } catch {
      return c.json({ error: "Invalid or expired token" }, 401);
    }
  });

  const requireRole = (...roles) => async (c, next) => {
    const user = c.get("user");
    if (!user || !roles.includes(user.role)) {
      return c.json({ error: "Not allowed for your role" }, 403);
    }
    await next();
  };

  // ---------- Access helpers ----------
  async function canSeeProject(user, project) {
    if (user.role === "PROJECT_MANAGER") return true;
    if (project.managerId === user.id) return true;
    return projects.isMember(project.id, user.id);
  }

  async function visibleProjects(user) {
    const all = await projects.list();
    const visible = [];
    for (const p of all) {
      if (await canSeeProject(user, p)) visible.push(p);
    }
    return visible;
  }

  async function visibleTasks(user) {
    if (user.role === "PROJECT_MANAGER") return tasks.list();
    const myProjectIds = new Set((await visibleProjects(user)).map((p) => p.id));
    return (await tasks.list()).filter(
      (t) => t.assigneeId === user.id || myProjectIds.has(t.projectId)
    );
  }

  // ---------- Users ----------
  app.get("/api/users", (c) => c.json(users.list()));

  // ---------- Notification settings (Settings tab) ----------
  app.get("/api/settings/notifications", async (c) => {
    return c.json(await userSettings.get(c.get("user").id));
  });

  app.put("/api/settings/notifications", async (c) => {
    const { errors, out } = validateSettingsPayload(await body(c));
    if (errors.length) return c.json({ error: errors.join("; ") }, 400);
    const current = await userSettings.get(c.get("user").id);
    const merged = {
      ...current,
      ...out,
      categories: { ...current.categories, ...(out.categories || {}) },
      sound: { ...current.sound, ...(out.sound || {}) },
    };
    return c.json(await userSettings.upsert(c.get("user").id, merged));
  });

  // ---------- Projects ----------
  app.get("/api/projects", async (c) => {
    return c.json(await visibleProjects(c.get("user")));
  });

  app.post(
    "/api/projects",
    requireRole("PROJECT_MANAGER"),
    async (c) => {
      const { name, description, startDate, endDate, memberIds } = await body(c);

      if (!name || !name.trim()) {
        return c.json({ error: "Project name is required" }, 400);
      }

      const validMembers = [];
      if (Array.isArray(memberIds)) {
        for (const id of memberIds) {
          const u = await users.findById(id);
          if (u && u.role !== "PROJECT_MANAGER") validMembers.push(id);
        }
      }

      if (startDate && endDate && endDate < startDate) {
        return c.json({ error: "End date must be after the start date" }, 400);
      }

      const created = await projects.create({
        name: name.trim(),
        description,
        managerId: c.get("user").id,
        memberIds: validMembers,
        startDate,
        endDate,
      });
      return c.json(created, 201);
    }
  );

  // ---------- Tasks ----------
  app.get("/api/tasks", async (c) => {
    return c.json(await visibleTasks(c.get("user")));
  });

  app.post(
    "/api/tasks",
    requireRole("PROJECT_MANAGER"),
    async (c) => {
      const { projectId, title, description, assigneeId, priority, dueDate, expectedMinutes } =
        await body(c);

      if (!projectId || !title) {
        return c.json({ error: "projectId and title are required" }, 400);
      }

      const project = await projects.findById(projectId);
      if (!project) {
        return c.json({ error: `Project ${projectId} not found` }, 404);
      }

      if (assigneeId) {
        const assignee = await users.findById(assigneeId);
        if (!assignee) {
          return c.json({ error: `User ${assigneeId} not found` }, 404);
        }
        if (assignee.role === "PROJECT_MANAGER") {
          return c.json(
            { error: "Tasks go to Team Leads or Developers, not a manager" },
            400
          );
        }
      }

      let expected = null;
      if (expectedMinutes !== undefined && expectedMinutes !== null && expectedMinutes !== "") {
        expected = Number(expectedMinutes);
        if (!Number.isInteger(expected) || expected < 0) {
          return c.json(
            { error: "expectedMinutes must be a non-negative integer" },
            400
          );
        }
      }

      const created = await tasks.create({
        projectId,
        title,
        description,
        assigneeId,
        priority,
        dueDate,
        expectedMinutes: expected,
      });
      if (created.assigneeId && created.assigneeId !== c.get("user").id) {
        await activityEvents.create({
          userId: created.assigneeId,
          kind: "task",
          title: "Task assigned",
          body: `${created.title} — assigned by ${c.get("user").name}`,
          taskId: created.id,
        });
      }
      return c.json(created, 201);
    }
  );

  const VALID_TASK_STATUSES = ["TODO", "IN_PROGRESS", "BLOCKED", "DONE"];

  app.patch("/api/tasks/:id", async (c) => {
    const { id } = c.req.param();
    const task = await tasks.findById(id);
    if (!task) {
      return c.json({ error: `Task ${id} not found` }, 404);
    }

    const isManager = c.get("user").role === "PROJECT_MANAGER";
    if (!isManager) {
      if (task.assigneeId !== c.get("user").id) {
        return c.json(
          { error: "You can only update the status of tasks assigned to you" },
          403
        );
      }
      const payload = await body(c);
      const keys = Object.keys(payload);
      const onlyStatus = keys.every((k) => k === "status");
      if (!onlyStatus) {
        return c.json({ error: "You can only change a task's status" }, 403);
      }
    }

    const { status, assigneeId, priority, dueDate, description, title, expectedMinutes } =
      await body(c);

    if (status !== undefined && !VALID_TASK_STATUSES.includes(status)) {
      return c.json({
        error: `Invalid status. Must be one of: ${VALID_TASK_STATUSES.join(", ")}`,
      }, 400);
    }

    if (assigneeId !== undefined && assigneeId !== null) {
      const assignee = await users.findById(assigneeId);
      if (!assignee) {
        return c.json({ error: `User ${assigneeId} not found` }, 404);
      }
      if (assignee.role === "PROJECT_MANAGER") {
        return c.json(
          { error: "Tasks go to Team Leads or Developers, not a manager" },
          400
        );
      }
    }

    if (
      expectedMinutes !== undefined &&
      expectedMinutes !== null &&
      expectedMinutes !== ""
    ) {
      const m = Number(expectedMinutes);
      if (!Number.isInteger(m) || m < 0) {
        return c.json(
          { error: "expectedMinutes must be a non-negative integer" },
          400
        );
      }
    }

    // A manual status flip to DONE records the completion timestamp; moving
    // off DONE (reopen) clears it.
    let completedAt = task.completedAt;
    if (status !== undefined && status !== task.status) {
      completedAt = status === "DONE" ? nowIso() : null;
    }

    const updated = await tasks.update(id, {
      status: status !== undefined ? status : task.status,
      assigneeId: assigneeId !== undefined ? assigneeId : task.assigneeId,
      priority: priority !== undefined ? priority : task.priority,
      dueDate: dueDate !== undefined ? dueDate : task.dueDate,
      description: description !== undefined ? description : task.description,
      title: title !== undefined ? title : task.title,
      expectedMinutes:
        expectedMinutes !== undefined && expectedMinutes !== null && expectedMinutes !== ""
          ? Number(expectedMinutes)
          : expectedMinutes === undefined
            ? task.expectedMinutes
            : null,
      completedAt,
    });

    // Task-status events: the assignee hears about changes made by others;
    // the PM hears about progress reported by the assignee.
    if (status !== undefined && status !== task.status) {
      const statusProject = await projects.findById(task.projectId);
      if (c.get("user").id !== task.assigneeId && task.assigneeId) {
        await activityEvents.create({
          userId: task.assigneeId,
          kind: "task",
          title: "Task status updated",
          body: `${updated.title}: ${task.status.replace("_", " ")} → ${updated.status.replace("_", " ")}`,
          taskId: task.id,
        });
      } else if (
        c.get("user").id === task.assigneeId &&
        statusProject &&
        statusProject.managerId !== c.get("user").id
      ) {
        await activityEvents.create({
          userId: statusProject.managerId,
          kind: "task",
          title: "Task status updated",
          body: `${updated.title}: ${task.status.replace("_", " ")} → ${updated.status.replace("_", " ")}`,
          taskId: task.id,
        });
      }
    }

    return c.json(updated);
  });

  // Complete a task (PM only): stops every open tracking session on it —
  // final durations saved — then flips the task to DONE.
  app.post(
    "/api/tasks/:id/complete",
    requireRole("PROJECT_MANAGER"),
    async (c) => {
      const task = await tasks.findById(c.req.param("id"));
      if (!task) {
        return c.json({ error: `Task ${c.req.param("id")} not found` }, 404);
      }
      if (task.status === "DONE") {
        return c.json({ error: "Task is already completed" }, 409);
      }

      const openSessions = await timelogs.findAllOpenByTask(task.id);
      const stoppedSessions = [];
      for (const log of openSessions) {
        stoppedSessions.push(await timelogs.stop(log.id));
      }
      const completed = await tasks.complete(task.id);
      const notifiedUsers = new Set();
      for (const log of stoppedSessions) {
        if (log.userId !== c.get("user").id && !notifiedUsers.has(log.userId)) {
          notifiedUsers.add(log.userId);
          await activityEvents.create({
            userId: log.userId,
            kind: "task",
            title: "Task completed",
            body: `${task.title} — marked completed by ${c.get("user").name}`,
            taskId: task.id,
          });
        }
      }
      return c.json({ task: completed, stoppedSessions });
    }
  );

  // ---------- Time tracking (PM-controlled) ----------
  app.get("/api/timelogs", async (c) => {
    const all = await timelogs.list();
    if (c.get("user").role === "PROJECT_MANAGER") return c.json(all);
    return c.json(all.filter((l) => l.userId === c.get("user").id));
  });

  app.post(
    "/api/timelogs/start",
    requireRole("PROJECT_MANAGER"),
    async (c) => {
      const { projectId, taskId, developerId, expectedMinutes, note } = await body(c);

      if (!projectId || !taskId) {
        return c.json({ error: "projectId and taskId are required" }, 400);
      }

      const task = await tasks.findById(taskId);
      if (!task) {
        return c.json({ error: `Task ${taskId} not found` }, 404);
      }
      if (task.projectId !== projectId) {
        return c.json({
          error: "The selected task does not belong to the selected project",
        }, 400);
      }
      if (!(await projects.findById(projectId))) {
        return c.json({ error: `Project ${projectId} not found` }, 404);
      }
      if (task.status === "DONE") {
        return c.json({
          error: "This task is completed — reopen it before tracking more time",
        }, 409);
      }

      const devId = developerId || task.assigneeId;
      if (!devId) {
        return c.json({
          error: "This task has no assigned developer — assign one first",
        }, 400);
      }
      if (task.assigneeId && devId !== task.assigneeId) {
        return c.json({
          error: "The selected developer does not match the task assignment",
        }, 400);
      }
      const developer = await users.findById(devId);
      if (!developer) {
        return c.json({ error: `User ${devId} not found` }, 404);
      }
      if (developer.role === "PROJECT_MANAGER") {
        return c.json(
          { error: "Tracking sessions belong to Team Leads or Developers" },
          400
        );
      }

      const runningForTask = await timelogs.findRunningByTask(taskId);
      if (runningForTask) {
        return c.json({
          error: "This task already has a running session",
          timelog: runningForTask,
        }, 409);
      }
      const runningForDeveloper = await timelogs.findRunningByDeveloper(devId);
      if (runningForDeveloper) {
        return c.json({
          error: `${developer.name} already has a running session`,
          timelog: runningForDeveloper,
        }, 409);
      }

      let expected = task.expectedMinutes;
      if (expectedMinutes !== undefined && expectedMinutes !== null && expectedMinutes !== "") {
        expected = Number(expectedMinutes);
        if (!Number.isInteger(expected) || expected < 0) {
          return c.json(
            { error: "expectedMinutes must be a non-negative integer" },
            400
          );
        }
      }

      const newLog = await timelogs.start({
        taskId,
        projectId,
        userId: devId,
        note,
        expectedMinutes: expected ?? null,
      });
      if (task.status !== "IN_PROGRESS") {
        await tasks.update(task.id, { status: "IN_PROGRESS" });
      }
      if (devId !== c.get("user").id) {
        await activityEvents.create({
          userId: devId,
          kind: "tracking",
          title: "Tracking started",
          body: `${task.title} — session started by ${c.get("user").name}`,
          taskId,
        });
      }

      return c.json(newLog, 201);
    }
  );

  app.post(
    "/api/timelogs/:id/pause",
    requireRole("PROJECT_MANAGER"),
    async (c) => {
      const log = await timelogs.findById(c.req.param("id"));
      if (!log) {
        return c.json({ error: `Time log ${c.req.param("id")} not found` }, 404);
      }
      if (log.status !== "RUNNING") {
        return c.json({ error: "Only a running entry can be paused" }, 409);
      }
      const updated = await timelogs.pause(log.id);
      const task = updated.taskId ? await tasks.findById(updated.taskId) : null;
      if (task && task.status === "IN_PROGRESS") {
        await tasks.update(task.id, { status: "TODO" });
      }
      if (updated.userId !== c.get("user").id) {
        await activityEvents.create({
          userId: updated.userId,
          kind: "tracking",
          title: "Tracking paused",
          body: `${task ? task.title : "Session"} — paused by ${c.get("user").name}`,
          taskId: updated.taskId,
        });
      }
      return c.json(updated);
    }
  );

  app.post(
    "/api/timelogs/:id/resume",
    requireRole("PROJECT_MANAGER"),
    async (c) => {
      const log = await timelogs.findById(c.req.param("id"));
      if (!log) {
        return c.json({ error: `Time log ${c.req.param("id")} not found` }, 404);
      }
      if (log.status !== "PAUSED") {
        return c.json({ error: "Only a paused entry can be resumed" }, 409);
      }
      const updated = await timelogs.resume(log.id);
      const task = updated.taskId ? await tasks.findById(updated.taskId) : null;
      if (task && task.status !== "DONE") {
        await tasks.update(task.id, { status: "IN_PROGRESS" });
      }
      if (updated.userId !== c.get("user").id) {
        await activityEvents.create({
          userId: updated.userId,
          kind: "tracking",
          title: "Tracking resumed",
          body: `${task ? task.title : "Session"} — resumed by ${c.get("user").name}`,
          taskId: updated.taskId,
        });
      }
      return c.json(updated);
    }
  );

  app.post(
    "/api/timelogs/:id/stop",
    requireRole("PROJECT_MANAGER"),
    async (c) => {
      const { id } = c.req.param();
      const { note } = await body(c);

      const log = await timelogs.findById(id);
      if (!log) {
        return c.json({ error: `Time log ${id} not found` }, 404);
      }
      if (log.endedAt !== null) {
        return c.json({ error: "Time log is already stopped" }, 409);
      }

      const updated = await timelogs.stop(id, note);
      if (log.taskId) await tasks.touch(log.taskId, updated.endedAt);
      if (updated.userId !== c.get("user").id) {
        const stoppedTask = log.taskId ? await tasks.findById(log.taskId) : null;
        await activityEvents.create({
          userId: updated.userId,
          kind: "tracking",
          title: "Tracking stopped",
          body: `${stoppedTask ? stoppedTask.title : "Session"} — stopped by ${
            c.get("user").name
          } (final: ${updated.minutes ?? 0}m)`,
          taskId: updated.taskId,
        });
      }

      return c.json(updated);
    }
  );

  app.patch("/api/timelogs/:id", requireRole("PROJECT_MANAGER"), async (c) => {
    const log = await timelogs.findById(c.req.param("id"));
    if (!log) {
      return c.json({ error: `Time log ${c.req.param("id")} not found` }, 404);
    }

    const { note, startedAt, endedAt, expectedMinutes } = await body(c);
    if (startedAt || endedAt) {
      if (log.endedAt === null) {
        return c.json({ error: "Stop the entry before editing its times" }, 400);
      }
      if (!startedAt || !endedAt) {
        return c.json(
          { error: "startedAt and endedAt must be provided together" },
          400
        );
      }
      const start = new Date(startedAt);
      const end = new Date(endedAt);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        return c.json({ error: "Invalid date/time" }, 400);
      }
      if (end < start) {
        return c.json({ error: "End must be after start" }, 400);
      }
    }
    if (
      expectedMinutes !== undefined &&
      expectedMinutes !== null &&
      expectedMinutes !== ""
    ) {
      const m = Number(expectedMinutes);
      if (!Number.isInteger(m) || m < 0) {
        return c.json(
          { error: "expectedMinutes must be a non-negative integer" },
          400
        );
      }
    }

    if (expectedMinutes !== undefined) {
      await timelogs.setExpected(
        log.id,
        expectedMinutes === null || expectedMinutes === ""
          ? null
          : Number(expectedMinutes)
      );
    }
    if (note !== undefined || startedAt !== undefined || endedAt !== undefined) {
      await timelogs.update(log.id, { note, startedAt, endedAt });
    }

    const updated = await timelogs.findById(log.id);
    if (updated.taskId) await tasks.touch(updated.taskId, nowIso());
    return c.json(updated);
  });

  app.delete("/api/timelogs/:id", requireRole("PROJECT_MANAGER"), async (c) => {
    const log = await timelogs.findById(c.req.param("id"));
    if (!log) {
      return c.json({ error: `Time log ${c.req.param("id")} not found` }, 404);
    }
    await timelogs.remove(log.id);
    return c.json({ ok: true });
  });

  // ---------- Scheduled update requests ----------
  async function enrichUpdateRequest(ur) {
    const task = await tasks.findById(ur.taskId);
    const developer = await users.findById(ur.developerId);
    const project = task ? await projects.findById(task.projectId) : null;
    return {
      ...ur,
      taskTitle: task ? task.title : "Unknown task",
      projectName: project ? project.name : "Unknown project",
      developerName: developer ? developer.name : "Unknown",
    };
  }

  app.post(
    "/api/update-requests",
    requireRole("PROJECT_MANAGER"),
    async (c) => {
      const { taskId, developerId, dueAt, note } = await body(c);

      if (!taskId || !developerId || !dueAt) {
        return c.json({ error: "taskId, developerId and dueAt are required" }, 400);
      }

      const task = await tasks.findById(taskId);
      if (!task) {
        return c.json({ error: `Task ${taskId} not found` }, 404);
      }

      const developer = await users.findById(developerId);
      if (!developer) {
        return c.json({ error: `User ${developerId} not found` }, 404);
      }
      if (developer.role === "PROJECT_MANAGER") {
        return c.json(
          { error: "Update requests go to Team Leads or Developers, not a manager" },
          400
        );
      }

      const when = new Date(dueAt);
      if (Number.isNaN(when.getTime())) {
        return c.json({ error: "dueAt must be a valid date/time" }, 400);
      }

      const created = await updateRequests.create({
        taskId,
        developerId,
        dueAt: when.toISOString(),
        note,
      });
      return c.json(await enrichUpdateRequest(created), 201);
    }
  );

  app.get("/api/update-requests", async (c) => {
    let result = await updateRequests.list();
    if (c.get("user").role !== "PROJECT_MANAGER") {
      result = result.filter((ur) => ur.developerId === c.get("user").id);
    }
    const status = c.req.query("status");
    if (status === "PENDING" || status === "FULFILLED") {
      result = result.filter((ur) => ur.status === status);
    }
    result = await Promise.all(result.map(enrichUpdateRequest));
    result.sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));
    return c.json(result);
  });

  app.patch("/api/update-requests/:id/fulfill", async (c) => {
    const ur = await updateRequests.findById(c.req.param("id"));
    if (!ur) {
      return c.json(
        { error: `Update request ${c.req.param("id")} not found` },
        404
      );
    }
    if (c.get("user").role !== "PROJECT_MANAGER" && c.get("user").id !== ur.developerId) {
      return c.json({ error: "Not allowed for your role" }, 403);
    }
    return c.json(await enrichUpdateRequest(await updateRequests.fulfill(ur.id)));
  });

  // ---------- Personal reminders ----------
  app.post("/api/personal-reminders", async (c) => {
    const { title, dueAt, note } = await body(c);

    if (!title || !dueAt) {
      return c.json({ error: "title and dueAt are required" }, 400);
    }

    const when = new Date(dueAt);
    if (Number.isNaN(when.getTime())) {
      return c.json({ error: "dueAt must be a valid date/time" }, 400);
    }

    const created = await personalReminders.create({
      userId: c.get("user").id,
      title,
      note,
      dueAt: when.toISOString(),
    });
    return c.json({ ...created, ownerName: c.get("user").name }, 201);
  });

  app.get("/api/personal-reminders", async (c) => {
    const result = (await personalReminders.listForUser(c.get("user").id))
      .sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt))
      .map((r) => ({ ...r, ownerName: c.get("user").name }));
    return c.json(result);
  });

  app.patch("/api/personal-reminders/:id", async (c) => {
    const pr = await personalReminders.findById(c.req.param("id"));
    if (!pr) {
      return c.json(
        { error: `Personal reminder ${c.req.param("id")} not found` },
        404
      );
    }
    if (pr.userId !== c.get("user").id) {
      return c.json({ error: "Not your reminder" }, 403);
    }
    const { done } = await body(c);
    const updated = await personalReminders.setDone(
      pr.id,
      done !== undefined ? Boolean(done) : true
    );
    return c.json({ ...updated, ownerName: c.get("user").name });
  });

  // ---------- Idle reminders ----------
  const REMINDER_IDLE_HOURS = 3;
  const REMINDER_IDLE_MS = REMINDER_IDLE_HOURS * 60 * 60 * 1000;
  const IDLE_WATCHED_STATUSES = ["IN_PROGRESS", "BLOCKED"];

  async function generateIdleReminders() {
    const now = Date.now();

    for (const task of await tasks.list()) {
      if (!IDLE_WATCHED_STATUSES.includes(task.status)) continue;

      const lastActivity = new Date(task.lastUpdatedAt).getTime();
      const idleFor = now - lastActivity;
      if (idleFor < REMINDER_IDLE_MS) continue;

      if (await idleReminders.hasUnresolvedForTask(task.id)) continue;

      const project = await projects.findById(task.projectId);
      const employee = task.assigneeId ? await users.findById(task.assigneeId) : null;

      await idleReminders.create({
        id: `r${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${task.id}`,
        taskId: task.id,
        taskTitle: task.title,
        projectId: task.projectId,
        projectName: project ? project.name : "Unknown project",
        employeeId: task.assigneeId,
        employeeName: employee ? employee.name : "Unassigned",
        lastActivityTime: task.lastUpdatedAt,
        status: task.status,
        reason: `No update for over ${REMINDER_IDLE_HOURS} hours while task is ${task.status}.`,
        createdAt: new Date(now).toISOString(),
      });
    }
  }

  async function enrichIdleReminder(r) {
    const task = await tasks.findById(r.taskId);
    const project = task ? await projects.findById(task.projectId) : null;
    const employee = r.employeeId ? await users.findById(r.employeeId) : null;
    return {
      ...r,
      taskTitle: task ? task.title : "Unknown task",
      projectName: project ? project.name : "Unknown project",
      employeeName: employee ? employee.name : "Unassigned",
    };
  }

  app.get(
    "/api/reminders",
    requireRole("PROJECT_MANAGER"),
    async (c) => {
      await generateIdleReminders();

      let result = await idleReminders.list();
      const resolved = c.req.query("resolved");
      if (resolved === "true") {
        result = result.filter((r) => r.resolved);
      } else if (resolved === "false") {
        result = result.filter((r) => !r.resolved);
      }

      result = await Promise.all(result.map(enrichIdleReminder));
      result.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

      return c.json(result);
    }
  );

  app.patch(
    "/api/reminders/:id",
    requireRole("PROJECT_MANAGER"),
    async (c) => {
      const { id } = c.req.param();
      const { resolved } = await body(c);

      const reminder = await idleReminders.findById(id);
      if (!reminder) {
        return c.json({ error: `Reminder ${id} not found` }, 404);
      }

      const updated = await idleReminders.setResolved(
        id,
        resolved !== undefined ? Boolean(resolved) : true
      );
      return c.json(await enrichIdleReminder(updated));
    }
  );

  // ---------- Unified notifications ----------
  app.get("/api/notifications", async (c) => {
    const now = nowIso();
    const user = c.get("user");
    const isManager = user.role === "PROJECT_MANAGER";
    const prefs = await userSettings.get(user.id);
    const masterOff = !prefs.masterEnabled;

    let dueUpdateRequests = [];
    let duePersonalReminders = [];
    let dueIdleReminders = [];
    let dueExpectedTime = [];

    if (!masterOff && prefs.categories.reminders) {
      dueUpdateRequests = (await updateRequests.list()).filter(
        (ur) =>
          ur.status === "PENDING" &&
          new Date(ur.dueAt).getTime() <= Date.now()
      );
      if (!isManager) {
        dueUpdateRequests = dueUpdateRequests.filter(
          (ur) => ur.developerId === user.id
        );
      }
      dueUpdateRequests = await Promise.all(
        dueUpdateRequests.map(async (ur) => {
          if (!ur.notifiedAt) await updateRequests.markNotified(ur.id, now);
          return enrichUpdateRequest(ur);
        })
      );

      duePersonalReminders = await Promise.all(
        (await personalReminders.listForUser(user.id))
          .filter(
            (pr) =>
              !pr.done && new Date(pr.dueAt).getTime() <= Date.now()
          )
          .map(async (pr) => {
            if (!pr.notifiedAt) await personalReminders.markNotified(pr.id, now);
            return pr;
          })
      );

      if (isManager) {
        await generateIdleReminders();
        dueIdleReminders = (await idleReminders.list())
          .filter((r) => !r.resolved)
          .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      }
    }

    // Expected-duration alerts (PM only). Fires once per threshold; suppressed
    // thresholds are NOT marked, so re-enabling later still surfaces them.
    if (!masterOff && isManager && prefs.categories.expectedTime) {
      const runningWithExpectation = (await timelogs.list()).filter(
        (l) =>
          l.status === "RUNNING" &&
          l.expectedMinutes != null &&
          l.expectedNotifiedAt === null
      );
      for (const l of runningWithExpectation) {
        const elapsedSeconds =
          l.accumulatedSeconds +
          (l.segmentStartedAt
            ? Math.max(
                0,
                Math.floor((Date.now() - new Date(l.segmentStartedAt).getTime()) / 1000)
              )
            : 0);
        if (elapsedSeconds < l.expectedMinutes * 60) continue;

        await timelogs.markExpectedNotified(l.id, now);
        const task = l.taskId ? await tasks.findById(l.taskId) : null;
        const project = task ? await projects.findById(task.projectId) : null;
        const developer = await users.findById(l.userId);
        dueExpectedTime.push({
          timelogId: l.id,
          taskId: l.taskId,
          taskTitle: task ? task.title : "Unknown task",
          projectName: project ? project.name : "Unknown project",
          developerName: developer ? developer.name : "Unknown",
          expectedMinutes: l.expectedMinutes,
          elapsedMinutes: Math.floor(elapsedSeconds / 60),
          elapsedSeconds,
        });
      }
    }

    // Deadline reminders: one event per task per day once the due date has
    // arrived (PM: all open tasks; others: their own assignments).
    if (!masterOff && prefs.categories.taskDeadlines) {
      const today = new Date().toISOString().slice(0, 10);
      const candidates = (await tasks.list()).filter(
        (t) => isManager || t.assigneeId === user.id
      );
      for (const t of candidates) {
        if (t.status === "DONE" || !t.dueDate || t.dueDate > today) continue;
        await activityEvents.create({
          userId: user.id,
          kind: "deadline",
          title: "Task deadline",
          body: `${t.title} is due ${t.dueDate} (status: ${t.status.replace("_", " ").toLowerCase()})`,
          taskId: t.id,
          dedupKey: `deadline:${t.id}:${today}`,
        });
      }
    }

    // Activity events, filtered by category and marked notified once surfaced.
    let activity = [];
    if (!masterOff) {
      const categoryFor = {
        tracking: "trackingActivity",
        task: "taskUpdates",
        deadline: "taskDeadlines",
      };
      const unseen = await activityEvents.listUnseen(user.id);
      const surfaced = unseen.filter((e) => prefs.categories[categoryFor[e.kind]]);
      await activityEvents.markNotified(
        surfaced.map((e) => e.id),
        now
      );
      activity = surfaced;
    }

    return c.json({
      updateRequests: dueUpdateRequests,
      personalReminders: duePersonalReminders,
      idleReminders: dueIdleReminders,
      expectedTime: dueExpectedTime,
      activity,
      count:
        dueUpdateRequests.length +
        duePersonalReminders.length +
        dueIdleReminders.length +
        dueExpectedTime.length +
        activity.length,
    });
  });

  // 404 for unmatched /api routes.
  app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

  return app;
}

module.exports = { createApp };
