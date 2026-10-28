const express = require("express");
const cors = require("cors");

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
} = require("./store");
const { login, authenticate, requireRole } = require("./auth");
const { initDb } = require("./db");

const app = express();
const PORT = process.env.PORT || 4000;

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

app.use(cors());
app.use(express.json());

app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

// ---------- Auth ----------
// Real email+password login (bcrypt hash check, see auth.js) replacing the
// old "pick a dummy user" flow. Returns a signed JWT the client must send as
// `Authorization: Bearer <token>` on every other request.
app.post(
  "/api/auth/login",
  asyncHandler(async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: "email and password are required" });
    }
    const result = await login(email, password);
    if (!result) {
      return res.status(401).json({ error: "Invalid email or password" });
    }
    res.json(result);
  })
);

app.get("/api/auth/me", authenticate, (req, res) => {
  res.json(req.user);
});

// Everything below requires a valid session.
app.use("/api", authenticate);

app.get(
  "/api/users",
  asyncHandler(async (req, res) => res.json(await users.list()))
);

// ---------- Notification settings (Settings tab) ----------
// Per-account preferences, persisted in user_settings. The API merges any
// partial payload over defaults and validates the shape, so a bad client can
// never corrupt the stored blob.

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

app.get(
  "/api/settings/notifications",
  asyncHandler(async (req, res) => res.json(await userSettings.get(req.user.id)))
);

app.put(
  "/api/settings/notifications",
  asyncHandler(async (req, res) => {
    const { errors, out } = validateSettingsPayload(req.body || {});
    if (errors.length) {
      return res.status(400).json({ error: errors.join("; ") });
    }
    const current = await userSettings.get(req.user.id);
    const merged = {
      ...current,
      ...out,
      categories: { ...current.categories, ...(out.categories || {}) },
      sound: { ...current.sound, ...(out.sound || {}) },
    };
    res.json(await userSettings.upsert(req.user.id, merged));
  })
);

// ---------- Access helpers ----------
// A user may see a project if they manage it or are a member of it; PMs see
// everything. Used to scope project/task/notification visibility per role.
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

app.get(
  "/api/projects",
  asyncHandler(async (req, res) => res.json(await visibleProjects(req.user)))
);

app.get(
  "/api/tasks",
  asyncHandler(async (req, res) => res.json(await visibleTasks(req.user)))
);

app.get(
  "/api/timelogs",
  asyncHandler(async (req, res) => {
    const all = await timelogs.list();
    if (req.user.role === "PROJECT_MANAGER") return res.json(all);
    res.json(all.filter((l) => l.userId === req.user.id));
  })
);

// ---------- Scheduled update requests ----------
// The PM schedules "time to get an update" appointments per developer + task.
// A request becomes DUE when dueAt passes and stays pending until fulfilled,
// which is what the notification endpoint surfaces.

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

// Only the Project Manager schedules update requests.
app.post(
  "/api/update-requests",
  requireRole("PROJECT_MANAGER"),
  asyncHandler(async (req, res) => {
    const { taskId, developerId, dueAt, note } = req.body || {};

    if (!taskId || !developerId || !dueAt) {
      return res.status(400).json({
        error: "taskId, developerId and dueAt are required",
      });
    }

    const task = await tasks.findById(taskId);
    if (!task) {
      return res.status(404).json({ error: `Task ${taskId} not found` });
    }

    const developer = await users.findById(developerId);
    if (!developer) {
      return res.status(404).json({ error: `User ${developerId} not found` });
    }
    if (developer.role === "PROJECT_MANAGER") {
      return res
        .status(400)
        .json({ error: "Update requests go to Team Leads or Developers, not a manager" });
    }

    const when = new Date(dueAt);
    if (Number.isNaN(when.getTime())) {
      return res.status(400).json({ error: "dueAt must be a valid date/time" });
    }

    const created = await updateRequests.create({
      taskId,
      developerId,
      dueAt: when.toISOString(),
      note,
    });
    res.status(201).json(await enrichUpdateRequest(created));
  })
);

// List update requests. PM sees all; everyone else sees only requests
// addressed to them. ?status=PENDING|FULFILLED filters further.
app.get(
  "/api/update-requests",
  asyncHandler(async (req, res) => {
    let result = await updateRequests.list();
    if (req.user.role !== "PROJECT_MANAGER") {
      result = result.filter((ur) => ur.developerId === req.user.id);
    }
    if (req.query.status === "PENDING" || req.query.status === "FULFILLED") {
      result = result.filter((ur) => ur.status === req.query.status);
    }
    result = await Promise.all(result.map(enrichUpdateRequest));
    result.sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));
    res.json(result);
  })
);

// Mark an update request fulfilled: the PM who asked, or the developer who
// owes the update, can do this.
app.patch(
  "/api/update-requests/:id/fulfill",
  asyncHandler(async (req, res) => {
    const ur = await updateRequests.findById(req.params.id);
    if (!ur) {
      return res
        .status(404)
        .json({ error: `Update request ${req.params.id} not found` });
    }
    if (req.user.role !== "PROJECT_MANAGER" && req.user.id !== ur.developerId) {
      return res.status(403).json({ error: "Not allowed for your role" });
    }
    res.json(await enrichUpdateRequest(await updateRequests.fulfill(ur.id)));
  })
);

// ---------- Personal reminders (per-user: meetings, calls, anything) ----------
// Always scoped to the caller — nobody can read or edit another user's
// personal reminders, PM included.

app.post(
  "/api/personal-reminders",
  asyncHandler(async (req, res) => {
    const { title, dueAt, note } = req.body || {};

    if (!title || !dueAt) {
      return res.status(400).json({ error: "title and dueAt are required" });
    }

    const when = new Date(dueAt);
    if (Number.isNaN(when.getTime())) {
      return res.status(400).json({ error: "dueAt must be a valid date/time" });
    }

    const created = await personalReminders.create({
      userId: req.user.id,
      title,
      note,
      dueAt: when.toISOString(),
    });
    res.status(201).json({ ...created, ownerName: req.user.name });
  })
);

app.get(
  "/api/personal-reminders",
  asyncHandler(async (req, res) => {
    const result = (await personalReminders.listForUser(req.user.id))
      .sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt))
      .map((r) => ({ ...r, ownerName: req.user.name }));
    res.json(result);
  })
);

// Mark a personal reminder done (or reopen it with {done:false}).
app.patch(
  "/api/personal-reminders/:id",
  asyncHandler(async (req, res) => {
    const pr = await personalReminders.findById(req.params.id);
    if (!pr) {
      return res
        .status(404)
        .json({ error: `Personal reminder ${req.params.id} not found` });
    }
    if (pr.userId !== req.user.id) {
      return res.status(403).json({ error: "Not your reminder" });
    }
    const { done } = req.body || {};
    const updated = await personalReminders.setDone(
      pr.id,
      done !== undefined ? Boolean(done) : true
    );
    res.json({ ...updated, ownerName: req.user.name });
  })
);

// ---------- Unified notifications ----------
// One call the frontend polls: everything that needs this user's attention
// right now. PMs get every due update request, every due idle-task alert, and
// their own due personal reminders. Everyone else gets update requests
// addressed to them (a nudge to report in) plus their own personal reminders.

app.get(
  "/api/notifications",
  asyncHandler(async (req, res) => {
    const now = nowIso();
    const isManager = req.user.role === "PROJECT_MANAGER";
    // Per-account preferences (Settings tab): the master switch and the
    // per-category switches gate every notification stream below, so a
    // suppressed category stays suppressed for every client.
    const prefs = await userSettings.get(req.user.id);
    const masterOff = !prefs.masterEnabled;

    let dueUpdateRequests = [];
    let duePersonalReminders = [];
    let dueIdleReminders = [];
    let dueExpectedTime = [];

    // Reminders: update requests, personal reminders, idle-task alerts.
    if (!masterOff && prefs.categories.reminders) {
      dueUpdateRequests = (await updateRequests.list()).filter(
        (ur) =>
          ur.status === "PENDING" &&
          new Date(ur.dueAt).getTime() <= Date.now()
      );
      if (!isManager) {
        dueUpdateRequests = dueUpdateRequests.filter(
          (ur) => ur.developerId === req.user.id
        );
      }
      dueUpdateRequests = await Promise.all(
        dueUpdateRequests.map(async (ur) => {
          if (!ur.notifiedAt) await updateRequests.markNotified(ur.id, now);
          return enrichUpdateRequest(ur);
        })
      );

      duePersonalReminders = await Promise.all(
        (await personalReminders.listForUser(req.user.id))
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

    // Expected-duration alerts (PM only): a running session whose actual
    // elapsed time has reached its expected duration. Fires once per
    // threshold (expected_notified_at); changing the threshold re-arms it.
    // Suppressed by the master or category switch — in that case the
    // threshold is NOT marked, so re-enabling later still surfaces it.
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
        (t) => isManager || t.assigneeId === req.user.id
      );
      for (const t of candidates) {
        if (t.status === "DONE" || !t.dueDate || t.dueDate > today) continue;
        await activityEvents.create({
          userId: req.user.id,
          kind: "deadline",
          title: "Task deadline",
          body: `${t.title} is due ${t.dueDate} (status: ${t.status.replace("_", " ").toLowerCase()})`,
          taskId: t.id,
          dedupKey: `deadline:${t.id}:${today}`,
        });
      }
    }

    // Activity events (tracking changes, task updates, deadlines), filtered
    // by their category switches and marked notified once surfaced. Events
    // suppressed by a disabled category stay unseen for 24h and surface if
    // the category is re-enabled later.
    let activity = [];
    if (!masterOff) {
      const categoryFor = {
        tracking: "trackingActivity",
        task: "taskUpdates",
        deadline: "taskDeadlines",
      };
      const unseen = await activityEvents.listUnseen(req.user.id);
      const surfaced = unseen.filter((e) => prefs.categories[categoryFor[e.kind]]);
      await activityEvents.markNotified(
        surfaced.map((e) => e.id),
        now
      );
      activity = surfaced;
    }

    res.json({
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
  })
);

const REMINDER_IDLE_HOURS = 3;
const REMINDER_IDLE_MS = REMINDER_IDLE_HOURS * 60 * 60 * 1000;
// Statuses where "no activity for a while" is actually worth flagging to the
// PM. A TODO task with no owner activity yet, or a DONE task, isn't idle in
// the sense we care about.
const IDLE_WATCHED_STATUSES = ["IN_PROGRESS", "BLOCKED"];

// Scan all tasks and create a reminder for any task that has been sitting in
// an active status (IN_PROGRESS/BLOCKED) with no update for more than
// REMINDER_IDLE_HOURS. Skips tasks that already have an unresolved reminder
// so re-running this doesn't spam duplicates; if the task becomes fresh
// again (edited) a new reminder can be generated once it goes stale again.
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

// GET /api/reminders re-scans for newly-idle tasks on every call. PM only —
// this is a management view of who's gone quiet.
app.get(
  "/api/reminders",
  requireRole("PROJECT_MANAGER"),
  asyncHandler(async (req, res) => {
    await generateIdleReminders();

    let result = await idleReminders.list();
    if (req.query.resolved === "true") {
      result = result.filter((r) => r.resolved);
    } else if (req.query.resolved === "false") {
      result = result.filter((r) => !r.resolved);
    }

    result = await Promise.all(result.map(enrichIdleReminder));
    result.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.json(result);
  })
);

// Mark a reminder as resolved/completed (e.g. the PM followed up).
app.patch(
  "/api/reminders/:id",
  requireRole("PROJECT_MANAGER"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { resolved } = req.body || {};

    const reminder = await idleReminders.findById(id);
    if (!reminder) {
      return res.status(404).json({ error: `Reminder ${id} not found` });
    }

    const updated = await idleReminders.setResolved(
      id,
      resolved !== undefined ? Boolean(resolved) : true
    );
    res.json(await enrichIdleReminder(updated));
  })
);

// Create a new project. Only the Project Manager can create projects, and
// they are always the manager of record (no spoofing managerId from the body).
app.post(
  "/api/projects",
  requireRole("PROJECT_MANAGER"),
  asyncHandler(async (req, res) => {
    const { name, description, startDate, endDate, memberIds } = req.body || {};

    if (!name || !name.trim()) {
      return res.status(400).json({ error: "Project name is required" });
    }

    const validMembers = [];
    if (Array.isArray(memberIds)) {
      for (const id of memberIds) {
        const u = await users.findById(id);
        if (u && u.role !== "PROJECT_MANAGER") validMembers.push(id);
      }
    }

    if (startDate && endDate && endDate < startDate) {
      return res
        .status(400)
        .json({ error: "End date must be after the start date" });
    }

    const created = await projects.create({
      name: name.trim(),
      description,
      managerId: req.user.id,
      memberIds: validMembers,
      startDate,
      endDate,
    });
    res.status(201).json(created);
  })
);

// Create a new task within a project. Only the Project Manager assigns tasks.
app.post(
  "/api/tasks",
  requireRole("PROJECT_MANAGER"),
  asyncHandler(async (req, res) => {
    const { projectId, title, description, assigneeId, priority, dueDate } =
      req.body || {};

    if (!projectId || !title) {
      return res.status(400).json({ error: "projectId and title are required" });
    }

    let expectedMinutes = null;
    if (
      req.body.expectedMinutes !== undefined &&
      req.body.expectedMinutes !== null &&
      req.body.expectedMinutes !== ""
    ) {
      expectedMinutes = Number(req.body.expectedMinutes);
      if (!Number.isInteger(expectedMinutes) || expectedMinutes < 0) {
        return res
          .status(400)
          .json({ error: "expectedMinutes must be a non-negative integer" });
      }
    }

    const project = await projects.findById(projectId);
    if (!project) {
      return res.status(404).json({ error: `Project ${projectId} not found` });
    }

    if (assigneeId) {
      const assignee = await users.findById(assigneeId);
      if (!assignee) {
        return res.status(404).json({ error: `User ${assigneeId} not found` });
      }
      if (assignee.role === "PROJECT_MANAGER") {
        return res
          .status(400)
          .json({ error: "Tasks go to Team Leads or Developers, not a manager" });
      }
    }

    const created = await tasks.create({
      projectId,
      title,
      description,
      assigneeId,
      priority,
      dueDate,
      expectedMinutes,
    });
    if (created.assigneeId && created.assigneeId !== req.user.id) {
      await activityEvents.create({
        userId: created.assigneeId,
        kind: "task",
        title: "Task assigned",
        body: `${created.title} — assigned by ${req.user.name}`,
        taskId: created.id,
      });
    }
    res.status(201).json(created);
  })
);

const VALID_TASK_STATUSES = ["TODO", "IN_PROGRESS", "BLOCKED", "DONE"];

// Update a task. The Project Manager can change anything (reassign,
// reprioritize, retitle). A Team Lead / Developer can only report progress —
// they may change `status` on a task assigned to them, nothing else.
app.patch(
  "/api/tasks/:id",
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const task = await tasks.findById(id);
    if (!task) {
      return res.status(404).json({ error: `Task ${id} not found` });
    }

    const isManager = req.user.role === "PROJECT_MANAGER";
    if (!isManager) {
      if (task.assigneeId !== req.user.id) {
        return res
          .status(403)
          .json({ error: "You can only update the status of tasks assigned to you" });
      }
      const keys = Object.keys(req.body || {});
      const onlyStatus = keys.every((k) => k === "status");
      if (!onlyStatus) {
        return res
          .status(403)
          .json({ error: "You can only change a task's status" });
      }
    }

    const { status, assigneeId, priority, dueDate, description, title, expectedMinutes } =
      req.body || {};

    if (status !== undefined && !VALID_TASK_STATUSES.includes(status)) {
      return res.status(400).json({
        error: `Invalid status. Must be one of: ${VALID_TASK_STATUSES.join(", ")}`,
      });
    }

    if (assigneeId !== undefined && assigneeId !== null) {
      const assignee = await users.findById(assigneeId);
      if (!assignee) {
        return res.status(404).json({ error: `User ${assigneeId} not found` });
      }
      if (assignee.role === "PROJECT_MANAGER") {
        return res
          .status(400)
          .json({ error: "Tasks go to Team Leads or Developers, not a manager" });
      }
    }

    if (expectedMinutes !== undefined && expectedMinutes !== null && expectedMinutes !== "") {
      const m = Number(expectedMinutes);
      if (!Number.isInteger(m) || m < 0) {
        return res
          .status(400)
          .json({ error: "expectedMinutes must be a non-negative integer" });
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
      if (req.user.id !== task.assigneeId && task.assigneeId) {
        await activityEvents.create({
          userId: task.assigneeId,
          kind: "task",
          title: "Task status updated",
          body: `${updated.title}: ${task.status.replace("_", " ")} → ${updated.status.replace("_", " ")}`,
          taskId: task.id,
        });
      } else if (
        req.user.id === task.assigneeId &&
        statusProject &&
        statusProject.managerId !== req.user.id
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

    res.json(updated);
  })
);

// Complete a task (PM only): stops every open tracking session on it — final
// durations saved — then flips the task to DONE with a completion timestamp.
// Tracking status and task status stay separate concerns: stopping timers is
// a side effect of completion here, never its cause.
app.post(
  "/api/tasks/:id/complete",
  requireRole("PROJECT_MANAGER"),
  asyncHandler(async (req, res) => {
    const task = await tasks.findById(req.params.id);
    if (!task) {
      return res.status(404).json({ error: `Task ${req.params.id} not found` });
    }
    if (task.status === "DONE") {
      return res.status(409).json({ error: "Task is already completed" });
    }

    const openSessions = await timelogs.findAllOpenByTask(task.id);
    const stoppedSessions = [];
    for (const log of openSessions) {
      stoppedSessions.push(await timelogs.stop(log.id));
    }
    const completed = await tasks.complete(task.id);
    // Task-completed event per affected developer (their trackers were just
    // stopped by the PM).
    const notifiedUsers = new Set();
    for (const log of stoppedSessions) {
      if (log.userId !== req.user.id && !notifiedUsers.has(log.userId)) {
        notifiedUsers.add(log.userId);
        await activityEvents.create({
          userId: log.userId,
          kind: "task",
          title: "Task completed",
          body: `${task.title} — marked completed by ${req.user.name}`,
          taskId: task.id,
        });
      }
    }
    res.json({ task: completed, stoppedSessions });
  })
);

// Start a tracking session (PM only): project + a task of that project + the
// task's assigned developer. The session is stored against the developer, with
// an optional expected duration (session value overrides the task default).
// Guards: task↔project match, developer↔assignment match, no tracking on
// completed tasks, one running session per task, one per developer.
app.post(
  "/api/timelogs/start",
  requireRole("PROJECT_MANAGER"),
  asyncHandler(async (req, res) => {
    const { projectId, taskId, developerId, expectedMinutes, note } = req.body || {};

    if (!projectId || !taskId) {
      return res.status(400).json({ error: "projectId and taskId are required" });
    }

    const task = await tasks.findById(taskId);
    if (!task) {
      return res.status(404).json({ error: `Task ${taskId} not found` });
    }
    if (task.projectId !== projectId) {
      return res.status(400).json({
        error: "The selected task does not belong to the selected project",
      });
    }
    if (!(await projects.findById(projectId))) {
      return res.status(404).json({ error: `Project ${projectId} not found` });
    }
    if (task.status === "DONE") {
      return res.status(409).json({
        error: "This task is completed — reopen it before tracking more time",
      });
    }

    const devId = developerId || task.assigneeId;
    if (!devId) {
      return res.status(400).json({
        error: "This task has no assigned developer — assign one first",
      });
    }
    if (task.assigneeId && devId !== task.assigneeId) {
      return res.status(400).json({
        error: "The selected developer does not match the task assignment",
      });
    }
    const developer = await users.findById(devId);
    if (!developer) {
      return res.status(404).json({ error: `User ${devId} not found` });
    }
    if (developer.role === "PROJECT_MANAGER") {
      return res
        .status(400)
        .json({ error: "Tracking sessions belong to Team Leads or Developers" });
    }

    const runningForTask = await timelogs.findRunningByTask(taskId);
    if (runningForTask) {
      return res.status(409).json({
        error: "This task already has a running session",
        timelog: runningForTask,
      });
    }
    const runningForDeveloper = await timelogs.findRunningByDeveloper(devId);
    if (runningForDeveloper) {
      return res.status(409).json({
        error: `${developer.name} already has a running session`,
        timelog: runningForDeveloper,
      });
    }

    let expected = task.expectedMinutes;
    if (expectedMinutes !== undefined && expectedMinutes !== null && expectedMinutes !== "") {
      expected = Number(expectedMinutes);
      if (!Number.isInteger(expected) || expected < 0) {
        return res
          .status(400)
          .json({ error: "expectedMinutes must be a non-negative integer" });
      }
    }

    const newLog = await timelogs.start({
      taskId,
      projectId,
      userId: devId,
      note,
      expectedMinutes: expected ?? null,
    });
    // Starting work moves the task into In Progress. Pausing or stopping the
    // timer later never completes it — completion is a separate PM action.
    if (task.status !== "IN_PROGRESS") {
      await tasks.update(task.id, { status: "IN_PROGRESS" });
    }
    // Activity event for the developer whose session just started (the PM
    // performed the action, so they don't notify themselves).
    if (devId !== req.user.id) {
      await activityEvents.create({
        userId: devId,
        kind: "tracking",
        title: "Tracking started",
        body: `${task.title} — session started by ${req.user.name}`,
        taskId,
      });
    }

    res.status(201).json(newLog);
  })
);

// Pause an open entry (PM only): banks the running segment so its elapsed
// time freezes without ending the entry. Only that entry changes. The task
// is no longer being actively worked, so an In Progress task drops back to
// Assigned (TODO); BLOCKED/DONE tasks are left untouched.
app.post(
  "/api/timelogs/:id/pause",
  requireRole("PROJECT_MANAGER"),
  asyncHandler(async (req, res) => {
    const log = await timelogs.findById(req.params.id);
    if (!log) {
      return res.status(404).json({ error: `Time log ${req.params.id} not found` });
    }
    if (log.status !== "RUNNING") {
      return res.status(409).json({ error: "Only a running entry can be paused" });
    }
    const updated = await timelogs.pause(log.id);
    const task = updated.taskId ? await tasks.findById(updated.taskId) : null;
    if (task && task.status === "IN_PROGRESS") {
      await tasks.update(task.id, { status: "TODO" });
    }
    if (updated.userId !== req.user.id) {
      await activityEvents.create({
        userId: updated.userId,
        kind: "tracking",
        title: "Tracking paused",
        body: `${task ? task.title : "Session"} — paused by ${req.user.name}`,
        taskId: updated.taskId,
      });
    }
    res.json(updated);
  })
);

// Resume a paused entry (PM only): starts a fresh running segment; banked
// time is kept. Work is active again, so the task returns to In Progress
// (unless it was completed).
app.post(
  "/api/timelogs/:id/resume",
  requireRole("PROJECT_MANAGER"),
  asyncHandler(async (req, res) => {
    const log = await timelogs.findById(req.params.id);
    if (!log) {
      return res.status(404).json({ error: `Time log ${req.params.id} not found` });
    }
    if (log.status !== "PAUSED") {
      return res.status(409).json({ error: "Only a paused entry can be resumed" });
    }
    const updated = await timelogs.resume(log.id);
    const task = updated.taskId ? await tasks.findById(updated.taskId) : null;
    if (task && task.status !== "DONE") {
      await tasks.update(task.id, { status: "IN_PROGRESS" });
    }
    if (updated.userId !== req.user.id) {
      await activityEvents.create({
        userId: updated.userId,
        kind: "tracking",
        title: "Tracking resumed",
        body: `${task ? task.title : "Session"} — resumed by ${req.user.name}`,
        taskId: updated.taskId,
      });
    }
    res.json(updated);
  })
);

// Edit an entry (PM only): note on any entry; start/end times of a completed
// one (both together — duration recomputed); expectedMinutes re-arms the
// expected-duration threshold for that session.
app.patch(
  "/api/timelogs/:id",
  requireRole("PROJECT_MANAGER"),
  asyncHandler(async (req, res) => {
    const log = await timelogs.findById(req.params.id);
    if (!log) {
      return res.status(404).json({ error: `Time log ${req.params.id} not found` });
    }

    const { note, startedAt, endedAt, expectedMinutes } = req.body || {};
    if (startedAt || endedAt) {
      if (log.endedAt === null) {
        return res
          .status(400)
          .json({ error: "Stop the entry before editing its times" });
      }
      if (!startedAt || !endedAt) {
        return res
          .status(400)
          .json({ error: "startedAt and endedAt must be provided together" });
      }
      const start = new Date(startedAt);
      const end = new Date(endedAt);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        return res.status(400).json({ error: "Invalid date/time" });
      }
      if (end < start) {
        return res.status(400).json({ error: "End must be after start" });
      }
    }
    if (expectedMinutes !== undefined && expectedMinutes !== null && expectedMinutes !== "") {
      const m = Number(expectedMinutes);
      if (!Number.isInteger(m) || m < 0) {
        return res
          .status(400)
          .json({ error: "expectedMinutes must be a non-negative integer" });
      }
    }

    if (expectedMinutes !== undefined) {
      // null/"" clears the threshold; a number re-arms the notification.
      await timelogs.setExpected(
        log.id,
        expectedMinutes === null || expectedMinutes === "" ? null : Number(expectedMinutes)
      );
    }
    if (note !== undefined || startedAt !== undefined || endedAt !== undefined) {
      await timelogs.update(log.id, { note, startedAt, endedAt });
    }

    const updated = await timelogs.findById(log.id);
    if (updated.taskId) await tasks.touch(updated.taskId, nowIso());
    res.json(updated);
  })
);

// Delete an entry (PM only). Deleting a running entry simply discards it.
app.delete(
  "/api/timelogs/:id",
  requireRole("PROJECT_MANAGER"),
  asyncHandler(async (req, res) => {
    const log = await timelogs.findById(req.params.id);
    if (!log) {
      return res.status(404).json({ error: `Time log ${req.params.id} not found` });
    }
    await timelogs.remove(log.id);
    res.json({ ok: true });
  })
);

// Stop an open entry (PM only): sets endedAt, computes the final duration
// (banked segments + current segment), and touches the task's lastUpdatedAt.
// Stopping never completes the task — that is a separate PM action.
app.post(
  "/api/timelogs/:id/stop",
  requireRole("PROJECT_MANAGER"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { note } = req.body || {};

    const log = await timelogs.findById(id);
    if (!log) {
      return res.status(404).json({ error: `Time log ${id} not found` });
    }
    if (log.endedAt !== null) {
      return res.status(409).json({ error: "Time log is already stopped" });
    }

    const updated = await timelogs.stop(id, note);
    if (log.taskId) await tasks.touch(log.taskId, updated.endedAt);
    if (updated.userId !== req.user.id) {
      const stoppedTask = log.taskId ? await tasks.findById(log.taskId) : null;
      await activityEvents.create({
        userId: updated.userId,
        kind: "tracking",
        title: "Tracking stopped",
        body: `${stoppedTask ? stoppedTask.title : "Session"} — stopped by ${
          req.user.name
        } (final: ${updated.minutes ?? 0}m)`,
        taskId: updated.taskId,
      });
    }

    res.json(updated);
  })
);

// 404 for unmatched /api routes, and a generic JSON error handler so a thrown
// error doesn't leak an HTML stack trace to the frontend.
app.use("/api", (req, res) => res.status(404).json({ error: "Not found" }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server listening on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("[db] Failed to initialize:", err);
    process.exit(1);
  });
