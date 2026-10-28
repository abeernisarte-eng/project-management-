import React, { useEffect, useMemo, useState } from "react";
import { api } from "../api/client.js";
import { useAuth } from "../context/AuthContext.jsx";

function fmtMinutes(minutes) {
  if (minutes == null) return "—";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function fmtClock(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

// ISO timestamp -> value for <input type="datetime-local"> (local time).
function toLocalInput(iso) {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
}

// Local calendar date (YYYY-MM-DD) of an entry, for the date filter.
function entryDate(iso) {
  return toLocalInput(iso).slice(0, 10);
}

// Live ticking elapsed for a RUNNING session; frozen total for PAUSED.
// Running time = banked seconds (paused segments) + current segment — the
// same math the server uses, so a page refresh never loses accuracy.
function Elapsed({ log }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (log.status !== "RUNNING") return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [log.status]);
  const seconds =
    log.status === "RUNNING"
      ? log.accumulatedSeconds +
        Math.max(0, (now - new Date(log.segmentStartedAt)) / 1000)
      : log.accumulatedSeconds;
  return <strong className="timer-running">{fmtClock(seconds)}</strong>;
}

// Total minutes of a session for the totals tables: completed sessions use
// the stored duration; open ones add banked time + the current segment.
function logTotalMinutes(log, now) {
  if (log.endedAt) return log.minutes || 0;
  const seconds =
    log.accumulatedSeconds +
    (log.status === "RUNNING" && log.segmentStartedAt
      ? Math.max(0, (now - new Date(log.segmentStartedAt)) / 1000)
      : 0);
  return Math.floor(seconds / 60);
}

const TRACK_BADGE = {
  RUNNING: "status-in_progress",
  PAUSED: "priority-medium",
  COMPLETED: "status-done",
};

function TrackBadge({ log }) {
  const status = log.status || (log.endedAt ? "COMPLETED" : "RUNNING");
  return (
    <span className={`badge ${TRACK_BADGE[status]}`}>{status.toLowerCase()}</span>
  );
}

const TASK_BADGE = {
  TODO: "priority-low",
  IN_PROGRESS: "status-in_progress",
  BLOCKED: "status-blocked",
  DONE: "status-done",
};

const TASK_LABELS = {
  TODO: "Assigned",
  IN_PROGRESS: "In progress",
  BLOCKED: "Blocked",
  DONE: "Completed",
};

function TaskBadge({ status }) {
  return (
    <span className={`badge ${TASK_BADGE[status] || "priority-low"}`}>
      {TASK_LABELS[status] || status.toLowerCase()}
    </span>
  );
}

export default function TimeTrackingPage() {
  const { currentUser, users } = useAuth();
  const isManager = currentUser.role === "PROJECT_MANAGER";
  const [projects, setProjects] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [timelogs, setTimelogs] = useState(null);
  const [error, setError] = useState(null);
  // PM start form: project -> task (of that project) -> developer (auto from
  // the task's assignment), expected duration + note.
  const [form, setForm] = useState({
    projectId: "",
    taskId: "",
    expectedMinutes: "",
    note: "",
  });
  // History filters (PM): project, task, developer, date, tracking status.
  const [filters, setFilters] = useState({
    projectId: "",
    taskId: "",
    developerId: "",
    date: "",
    status: "",
  });
  // Inline edit state for a completed history row.
  const [edit, setEdit] = useState(null);

  async function load() {
    try {
      const [p, t, l] = await Promise.all([
        api.get("/projects"),
        api.get("/tasks"),
        api.get("/timelogs"),
      ]);
      setProjects(p);
      setTasks(t);
      setTimelogs(l);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const now = Date.now();

  const activeSessions = useMemo(
    () =>
      (timelogs || [])
        .filter((l) => l.endedAt === null)
        .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt)),
    [timelogs]
  );

  const filtered = useMemo(() => {
    return (timelogs || [])
      .filter((l) => !filters.projectId || l.projectId === filters.projectId)
      .filter((l) => !filters.taskId || l.taskId === filters.taskId)
      .filter((l) => !filters.developerId || l.userId === filters.developerId)
      .filter((l) => !filters.date || entryDate(l.startedAt) === filters.date)
      .filter(
        (l) =>
          !filters.status ||
          (l.status || (l.endedAt ? "COMPLETED" : "RUNNING")) === filters.status
      )
      .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  }, [timelogs, filters]);

  const totals = useMemo(() => {
    const by = {};
    for (const l of filtered) {
      const m = logTotalMinutes(l, now);
      if (m <= 0) continue;
      const dev = users.find((u) => u.id === l.userId)?.name || "Unknown";
      const task = tasks.find((t) => t.id === l.taskId)?.title || "No task";
      const project =
        projects.find((p) => p.id === l.projectId)?.name || "Unknown project";
      by.dev = by.dev || {};
      by.dev[dev] = (by.dev[dev] || 0) + m;
      by.task = by.task || {};
      by.task[task] = (by.task[task] || 0) + m;
      by.project = by.project || {};
      by.project[project] = (by.project[project] || 0) + m;
    }
    const toRows = (obj) =>
      Object.entries(obj || {})
        .map(([name, minutes]) => ({ name, minutes }))
        .sort((a, b) => b.minutes - a.minutes);
    return { dev: toRows(by.dev), task: toRows(by.task), project: toRows(by.project) };
  }, [filtered, users, tasks, projects, now]);

  // Employee read-only view: their own sessions.
  const mySessions = useMemo(
    () =>
      (timelogs || [])
        .filter((l) => l.userId === currentUser.id)
        .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt)),
    [timelogs, currentUser.id]
  );

  function taskLabel(log) {
    return tasks.find((t) => t.id === log.taskId)?.title || log.taskId || "—";
  }
  function projectLabel(log) {
    return projects.find((p) => p.id === log.projectId)?.name || "—";
  }

  async function startTracking(e) {
    e.preventDefault();
    setError(null);
    if (!form.projectId || !form.taskId) {
      setError("Select a project and a task first.");
      return;
    }
    const task = tasks.find((t) => t.id === form.taskId);
    if (!task?.assigneeId) {
      setError("This task has no assigned developer — assign one on the Tasks page.");
      return;
    }
    try {
      await api.post("/timelogs/start", {
        projectId: form.projectId,
        taskId: form.taskId,
        developerId: task.assigneeId,
        expectedMinutes:
          form.expectedMinutes === "" ? undefined : Number(form.expectedMinutes),
        note: form.note,
      });
      setForm((f) => ({ ...f, taskId: "", expectedMinutes: "", note: "" }));
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function act(path) {
    setError(null);
    try {
      await api.post(path, {});
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  // Complete task (PM): stops all open sessions on the task server-side and
  // flips the task to DONE with a completion timestamp. Tracking status and
  // task status stay separate — stopping is a side effect here only.
  async function completeTask(taskId) {
    if (
      !window.confirm(
        "Stop all open tracking sessions on this task and mark it completed?"
      )
    )
      return;
    setError(null);
    try {
      await api.post(`/tasks/${taskId}/complete`, {});
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function deleteLog(log) {
    setError(null);
    try {
      await api.del(`/timelogs/${log.id}`);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  function beginEdit(log) {
    setEdit({
      id: log.id,
      startedAt: toLocalInput(log.startedAt),
      endedAt: toLocalInput(log.endedAt),
      expectedMinutes: log.expectedMinutes ?? "",
      note: log.note || "",
    });
  }

  async function saveEdit(e) {
    e.preventDefault();
    setError(null);
    if (!edit.startedAt || !edit.endedAt) {
      setError("Start and end times are both required.");
      return;
    }
    if (new Date(edit.endedAt) < new Date(edit.startedAt)) {
      setError("End must be after start.");
      return;
    }
    try {
      await api.patch(`/timelogs/${edit.id}`, {
        note: edit.note,
        expectedMinutes: edit.expectedMinutes === "" ? null : Number(edit.expectedMinutes),
        startedAt: new Date(edit.startedAt).toISOString(),
        endedAt: new Date(edit.endedAt).toISOString(),
      });
      setEdit(null);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  if (error && !timelogs)
    return <p className="error-text">Failed to load time tracking: {error}</p>;
  if (!timelogs) return <p className="muted">Loading…</p>;

  const selectedTask = tasks.find((t) => t.id === form.taskId);
  const selectedProjectTasks = tasks.filter(
    (t) => t.projectId === form.projectId && t.status !== "DONE"
  );
  const filtersDirty =
    filters.projectId || filters.taskId || filters.developerId || filters.date || filters.status;

  const filterUi = (
    <div className="filters" style={{ marginBottom: "var(--s3)" }}>
      <label>
        Project
        <select
          value={filters.projectId}
          onChange={(e) =>
            setFilters((f) => ({ ...f, projectId: e.target.value, taskId: "" }))
          }
        >
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Task
        <select
          value={filters.taskId}
          onChange={(e) => setFilters((f) => ({ ...f, taskId: e.target.value }))}
        >
          <option value="">All tasks</option>
          {tasks
            .filter((t) => !filters.projectId || t.projectId === filters.projectId)
            .map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
        </select>
      </label>
      {isManager && (
        <label>
          Developer
          <select
            value={filters.developerId}
            onChange={(e) =>
              setFilters((f) => ({ ...f, developerId: e.target.value }))
            }
          >
            <option value="">All developers</option>
            {users
              .filter((u) => u.role !== "PROJECT_MANAGER")
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
          </select>
        </label>
      )}
      <label>
        Date
        <input
          type="date"
          value={filters.date}
          onChange={(e) => setFilters((f) => ({ ...f, date: e.target.value }))}
        />
      </label>
      <label>
        Tracking status
        <select
          value={filters.status}
          onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}
        >
          <option value="">All</option>
          <option value="RUNNING">Running</option>
          <option value="PAUSED">Paused</option>
          <option value="COMPLETED">Stopped</option>
        </select>
      </label>
      {filtersDirty && (
        <button
          className="btn"
          type="button"
          onClick={() =>
            setFilters({ projectId: "", taskId: "", developerId: "", date: "", status: "" })
          }
        >
          Clear filters
        </button>
      )}
    </div>
  );

  const totalsTables = (
    <div className="stat-grid" style={{ marginTop: "var(--s4)" }}>
      {[
        { title: "Per developer", rows: totals.dev },
        { title: "Per task", rows: totals.task },
        { title: "Per project", rows: totals.project },
      ].map(({ title, rows }) => (
        <div key={title}>
          <h2 style={{ marginBottom: "var(--s2)" }}>{title}</h2>
          <table className="table">
            <thead>
              <tr>
                <th>{title.replace("Per ", "")}</th>
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.name}>
                  <td>{r.name}</td>
                  <td>{fmtMinutes(r.minutes)}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={2} className="muted">
                    Nothing in the current filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );

  // ---------- Developer (read-only) view ----------
  if (!isManager) {
    return (
      <div className="page">
        <h1>Time Tracking</h1>
        <p className="muted" style={{ marginTop: "calc(var(--s4) * -1 + var(--s2))" }}>
          Your tracked sessions, managed by the project manager. Read-only.
        </p>
        <section className="card">
          <h2>My tracked time</h2>
          <table className="table">
            <thead>
              <tr>
                <th>Project</th>
                <th>Task</th>
                <th>Date</th>
                <th>Started</th>
                <th>Ended</th>
                <th>Duration</th>
                <th>Status</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {mySessions.map((l) => (
                <tr key={l.id}>
                  <td>{projectLabel(l)}</td>
                  <td>{taskLabel(l)}</td>
                  <td className="muted">{entryDate(l.startedAt)}</td>
                  <td className="muted">
                    {new Date(l.startedAt).toLocaleTimeString()}
                  </td>
                  <td className="muted">
                    {l.endedAt ? new Date(l.endedAt).toLocaleTimeString() : "running"}
                  </td>
                  <td>
                    {l.endedAt === null ? <Elapsed log={l} /> : fmtMinutes(l.minutes)}
                  </td>
                  <td>
                    <TrackBadge log={l} />
                  </td>
                  <td className="muted">{l.note || "—"}</td>
                </tr>
              ))}
              {mySessions.length === 0 && (
                <tr>
                  <td colSpan={8} className="muted">
                    No tracked time yet — the project manager starts and manages
                    your sessions.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
      </div>
    );
  }

  // ---------- Project Manager view ----------
  return (
    <div className="page">
      <h1>Time Tracking</h1>

      {/* Start Tracking: project -> task -> developer (auto from assignment). */}
      <form className="card timer-card" onSubmit={startTracking}>
        <h2>Start tracking</h2>
        <div className="form-grid">
          <label>
            Project
            <select
              value={form.projectId}
              onChange={(e) =>
                setForm((f) => ({ ...f, projectId: e.target.value, taskId: "" }))
              }
            >
              <option value="" disabled>
                Select project…
              </option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Task (of the selected project)
            <select
              value={form.taskId}
              onChange={(e) => {
                const task = tasks.find((t) => t.id === e.target.value);
                setForm((f) => ({
                  ...f,
                  taskId: e.target.value,
                  expectedMinutes:
                    task?.expectedMinutes != null ? String(task.expectedMinutes) : f.expectedMinutes,
                }));
              }}
            >
              <option value="" disabled>
                {form.projectId ? "Select task…" : "Select a project first…"}
              </option>
              {selectedProjectTasks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            Assigned developer
            {selectedTask?.assigneeId ? (
              <input
                type="text"
                value={
                  users.find((u) => u.id === selectedTask.assigneeId)?.name ||
                  "Unknown"
                }
                disabled
              />
            ) : (
              <input
                type="text"
                value="—"
                disabled
                aria-label="No developer assigned"
              />
            )}
          </label>
          <label>
            Expected duration (minutes, optional)
            <input
              type="number"
              min="0"
              value={form.expectedMinutes}
              onChange={(e) =>
                setForm((f) => ({ ...f, expectedMinutes: e.target.value }))
              }
              placeholder="e.g. 120"
            />
          </label>
          <label className="form-wide">
            Note (optional)
            <input
              type="text"
              value={form.note}
              onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
              placeholder="What is this session about?"
            />
          </label>
        </div>
        {selectedTask && !selectedTask.assigneeId && (
          <p className="error-text">
            This task has no assigned developer — assign one on the Tasks page
            before tracking.
          </p>
        )}
        <button
          className="btn btn-primary"
          type="submit"
          disabled={!form.projectId || !form.taskId || !selectedTask?.assigneeId}
        >
          Start tracking
        </button>
      </form>

      {error && <p className="error-text">{error}</p>}

      {/* Active sessions — each fully independent. */}
      {activeSessions.length > 0 && (
        <section className="card">
          <h2>Active sessions ({activeSessions.length})</h2>
          <div className="stat-grid">
            {activeSessions.map((l) => {
              const task = tasks.find((t) => t.id === l.taskId);
              return (
                <div key={l.id} className="card timer-card">
                  <div className="project-card-header">
                    <h2>{taskLabel(l)}</h2>
                    <TrackBadge log={l} />
                  </div>
                  <p className="muted" style={{ margin: "var(--s1) 0" }}>
                    {projectLabel(l)} ·{" "}
                    {users.find((u) => u.id === l.userId)?.name || "Unknown"}
                  </p>
                  <p style={{ margin: "var(--s1) 0" }}>
                    {l.status === "PAUSED" ? "Paused at" : "Running"}{" "}
                    <Elapsed log={l} />
                    {l.expectedMinutes != null && (
                      <span className="muted"> / expected {fmtMinutes(l.expectedMinutes)}</span>
                    )}
                  </p>
                  <p className="muted" style={{ margin: "var(--s1) 0" }}>
                    Started {new Date(l.startedAt).toLocaleString()}
                  </p>
                  {l.note && <p className="muted task-desc">{l.note}</p>}
                  <div className="form-actions" style={{ marginTop: "var(--s2)" }}>
                    {l.status === "RUNNING" && (
                      <button className="btn" onClick={() => act(`/timelogs/${l.id}/pause`)}>
                        Pause
                      </button>
                    )}
                    {l.status === "PAUSED" && (
                      <button className="btn" onClick={() => act(`/timelogs/${l.id}/resume`)}>
                        Resume
                      </button>
                    )}
                    <button className="btn btn-primary" onClick={() => act(`/timelogs/${l.id}/stop`)}>
                      Stop
                    </button>
                    {task && task.status !== "DONE" && (
                      <button className="btn" onClick={() => completeTask(task.id)}>
                        Complete task
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* History + filters + totals. */}
      <section className="card">
        <h2>Time tracking history</h2>
        {filterUi}
        <table className="table">
          <thead>
            <tr>
              <th>Developer</th>
              <th>Project</th>
              <th>Task</th>
              <th>Date</th>
              <th>Started</th>
              <th>Ended</th>
              <th>Duration</th>
              <th>Expected</th>
              <th>Tracking</th>
              <th>Task status</th>
              <th>Note</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {edit && (
              <tr>
                <td colSpan={12}>
                  <form
                    onSubmit={saveEdit}
                    className="form-grid"
                    style={{ marginBottom: 0 }}
                  >
                    <label>
                      Started
                      <input
                        type="datetime-local"
                        value={edit.startedAt}
                        onChange={(e) =>
                          setEdit((s) => ({ ...s, startedAt: e.target.value }))
                        }
                      />
                    </label>
                    <label>
                      Ended
                      <input
                        type="datetime-local"
                        value={edit.endedAt}
                        onChange={(e) =>
                          setEdit((s) => ({ ...s, endedAt: e.target.value }))
                        }
                      />
                    </label>
                    <label>
                      Expected (min)
                      <input
                        type="number"
                        min="0"
                        value={edit.expectedMinutes}
                        onChange={(e) =>
                          setEdit((s) => ({ ...s, expectedMinutes: e.target.value }))
                        }
                      />
                    </label>
                    <label className="form-wide">
                      Note
                      <input
                        type="text"
                        value={edit.note}
                        onChange={(e) => setEdit((s) => ({ ...s, note: e.target.value }))}
                      />
                    </label>
                    <div className="form-actions form-wide">
                      <button className="btn btn-primary" type="submit">
                        Save
                      </button>
                      <button className="btn" type="button" onClick={() => setEdit(null)}>
                        Cancel
                      </button>
                    </div>
                  </form>
                </td>
              </tr>
            )}
            {filtered.map((l) => {
              const task = tasks.find((t) => t.id === l.taskId);
              return (
                <tr key={l.id}>
                  <td>
                    {users.find((u) => u.id === l.userId)?.name || l.userId}
                  </td>
                  <td>{projectLabel(l)}</td>
                  <td>{taskLabel(l)}</td>
                  <td className="muted">{entryDate(l.startedAt)}</td>
                  <td className="muted">
                    {new Date(l.startedAt).toLocaleTimeString()}
                  </td>
                  <td className="muted">
                    {l.endedAt ? new Date(l.endedAt).toLocaleTimeString() : "running"}
                  </td>
                  <td>
                    {l.endedAt === null ? <Elapsed log={l} /> : fmtMinutes(l.minutes)}
                  </td>
                  <td className="muted">
                    {l.expectedMinutes != null ? fmtMinutes(l.expectedMinutes) : "—"}
                  </td>
                  <td>
                    <TrackBadge log={l} />
                  </td>
                  <td>
                    {task ? <TaskBadge status={task.status} /> : "—"}
                  </td>
                  <td className="muted">{l.note || "—"}</td>
                  <td>
                    <div className="form-actions">
                      {l.status === "RUNNING" && (
                        <button
                          className="btn"
                          onClick={() => act(`/timelogs/${l.id}/pause`)}
                        >
                          Pause
                        </button>
                      )}
                      {l.status === "PAUSED" && (
                        <button
                          className="btn"
                          onClick={() => act(`/timelogs/${l.id}/resume`)}
                        >
                          Resume
                        </button>
                      )}
                      {l.endedAt === null && (
                        <button
                          className="btn"
                          onClick={() => act(`/timelogs/${l.id}/stop`)}
                        >
                          Stop
                        </button>
                      )}
                      {task && task.status !== "DONE" && (
                        <button className="btn" onClick={() => completeTask(task.id)}>
                          Complete
                        </button>
                      )}
                      {l.endedAt !== null && (
                        <>
                          <button className="btn" onClick={() => beginEdit(l)}>
                            Edit
                          </button>
                          <button className="btn" onClick={() => deleteLog(l)}>
                            Delete
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={12} className="muted">
                  No tracking sessions match the filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {totalsTables}
      </section>
    </div>
  );
}
