import React, { useEffect, useState } from "react";
import { api } from "../api/client.js";
import { useAuth } from "../context/AuthContext.jsx";

const STATUSES = ["TODO", "IN_PROGRESS", "BLOCKED", "DONE"];
const PRIORITIES = ["LOW", "MEDIUM", "HIGH"];

const STATUS_LABELS = {
  TODO: "To do",
  IN_PROGRESS: "In progress",
  BLOCKED: "Blocked",
  DONE: "Done",
};

function TaskForm({ projects, users, onCreated }) {
  const [form, setForm] = useState({
    projectId: "",
    title: "",
    description: "",
    assigneeId: "",
    priority: "MEDIUM",
    dueDate: "",
    expectedMinutes: "",
  });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  function update(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    if (!form.projectId || !form.title) {
      setError("Project and title are required.");
      return;
    }
    setSaving(true);
    try {
      const created = await api.post("/tasks", {
        projectId: form.projectId,
        title: form.title,
        description: form.description,
        assigneeId: form.assigneeId || null,
        priority: form.priority,
        dueDate: form.dueDate || null,
        expectedMinutes:
          form.expectedMinutes === "" ? null : Number(form.expectedMinutes),
      });
      onCreated(created);
      setForm({
        projectId: "",
        title: "",
        description: "",
        assigneeId: "",
        priority: "MEDIUM",
        dueDate: "",
        expectedMinutes: "",
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="card task-form" onSubmit={handleSubmit}>
      <h2>Create task</h2>
      <div className="form-grid">
        <label>
          Project
          <select
            value={form.projectId}
            onChange={(e) => update("projectId", e.target.value)}
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
          Title
          <input
            type="text"
            value={form.title}
            onChange={(e) => update("title", e.target.value)}
            placeholder="What needs doing?"
          />
        </label>

        <label>
          Assignee (Team Lead or Developer)
          <select
            value={form.assigneeId}
            onChange={(e) => update("assigneeId", e.target.value)}
          >
            <option value="">Unassigned</option>
            {users
              .filter((u) => u.role !== "PROJECT_MANAGER")
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
          </select>
        </label>

        <label>
          Priority
          <select
            value={form.priority}
            onChange={(e) => update("priority", e.target.value)}
          >
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>

        <label>
          Due date
          <input
            type="date"
            value={form.dueDate}
            onChange={(e) => update("dueDate", e.target.value)}
          />
        </label>

        <label>
          Expected duration (minutes, optional)
          <input
            type="number"
            min="0"
            value={form.expectedMinutes}
            onChange={(e) => update("expectedMinutes", e.target.value)}
            placeholder="e.g. 120"
          />
        </label>

        <label className="form-wide">
          Description
          <textarea
            rows={2}
            value={form.description}
            onChange={(e) => update("description", e.target.value)}
            placeholder="Optional details"
          />
        </label>
      </div>

      {error && <p className="error-text">{error}</p>}

      <button className="btn btn-primary" disabled={saving} type="submit">
        {saving ? "Creating…" : "Create task"}
      </button>
    </form>
  );
}

export default function TasksPage() {
  const { users } = useAuth();
  const [tasks, setTasks] = useState(null);
  const [projects, setProjects] = useState([]);
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [assigneeFilter, setAssigneeFilter] = useState("ALL");
  const [error, setError] = useState(null);
  // Task id whose "schedule update request" panel is open, or null.
  const [requestingFor, setRequestingFor] = useState(null);
  const [requestForm, setRequestForm] = useState({
    developerId: "",
    dueAt: "",
    note: "",
  });
  const [requestMsg, setRequestMsg] = useState("");

  async function load() {
    try {
      const [t, p] = await Promise.all([api.get("/tasks"), api.get("/projects")]);
      setTasks(t);
      setProjects(p);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
  }, []);

  if (error)
    return <p className="error-text">Failed to load tasks: {error}</p>;
  if (!tasks) return <p className="muted">Loading tasks…</p>;

  async function changeStatus(task, status) {
    try {
      const updated = await api.patch(`/tasks/${task.id}`, { status });
      setTasks((ts) => ts.map((t) => (t.id === updated.id ? updated : t)));
    } catch (err) {
      setError(err.message);
    }
  }

  function openRequestPanel(task) {
    setRequestingFor(task.id);
    setRequestMsg("");
    setRequestForm({
      developerId: task.assigneeId || "",
      dueAt: "",
      note: "",
    });
  }

  async function submitUpdateRequest(e) {
    e.preventDefault();
    setRequestMsg("");
    const task = tasks.find((t) => t.id === requestingFor);
    if (!task) return;
    if (!requestForm.developerId || !requestForm.dueAt) {
      setRequestMsg("Choose a developer and a date/time.");
      return;
    }
    try {
      await api.post("/update-requests", {
        taskId: task.id,
        developerId: requestForm.developerId,
        dueAt: new Date(requestForm.dueAt).toISOString(),
        note: requestForm.note,
      });
      const dev = users.find((u) => u.id === requestForm.developerId);
      setRequestMsg(
        `Update request scheduled for ${dev ? dev.name : "developer"} on ${new Date(
          requestForm.dueAt
        ).toLocaleString()}. You'll get a notification when the time arrives.`
      );
      setRequestingFor(null);
    } catch (err) {
      setRequestMsg(err.message);
    }
  }

  const visible = tasks.filter(
    (t) =>
      (statusFilter === "ALL" || t.status === statusFilter) &&
      (assigneeFilter === "ALL" || t.assigneeId === assigneeFilter)
  );

  return (
    <div className="page">
      <h1>Tasks</h1>

      <TaskForm
        projects={projects}
        users={users}
        onCreated={(created) => setTasks((ts) => [...ts, created])}
      />

      <div className="filters">
        <label>
          Status
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="ALL">All</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Assignee
          <select
            value={assigneeFilter}
            onChange={(e) => setAssigneeFilter(e.target.value)}
          >
            <option value="ALL">Everyone</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <table className="table">
        <thead>
          <tr>
            <th>Task</th>
            <th>Project</th>
            <th>Assignee</th>
            <th>Priority</th>
            <th>Due</th>
            <th>Status</th>
            <th>Update</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((t) => {
            const project = projects.find((p) => p.id === t.projectId);
            const assignee = users.find((u) => u.id === t.assigneeId);
            return (
              <tr key={t.id}>
                <td>
                  <strong>{t.title}</strong>
                  {t.description && (
                    <div className="muted task-desc">{t.description}</div>
                  )}
                  {t.expectedMinutes != null && (
                    <div className="muted task-desc">
                      Expected: {Math.floor(t.expectedMinutes / 60) > 0
                        ? `${Math.floor(t.expectedMinutes / 60)}h `
                        : ""}
                      {t.expectedMinutes % 60}m
                    </div>
                  )}
                </td>
                <td>{project ? project.name : "—"}</td>
                <td>{assignee ? assignee.name : "Unassigned"}</td>
                <td>
                  <span className={`badge priority-${t.priority.toLowerCase()}`}>
                    {t.priority}
                  </span>
                </td>
                <td className="muted">
                  {t.dueDate ? t.dueDate : "—"}
                </td>
                <td>
                  <select
                    className={`status-select status-${t.status.toLowerCase()}`}
                    value={t.status}
                    onChange={(e) => changeStatus(t, e.target.value)}
                  >
                    {STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {STATUS_LABELS[s]}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <button
                    className="btn"
                    onClick={() =>
                      requestingFor === t.id
                        ? setRequestingFor(null)
                        : openRequestPanel(t)
                    }
                  >
                    {requestingFor === t.id ? "Close" : "Request update"}
                  </button>
                </td>
              </tr>
            );
          })}
          {visible.length === 0 && (
            <tr>
              <td colSpan={7} className="muted">
                No tasks match these filters.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {requestMsg && <p className="muted">{requestMsg}</p>}

      {requestingFor && (
        <form className="card request-panel" onSubmit={submitUpdateRequest}>
          <h2>
            Schedule update request —{" "}
            {tasks.find((t) => t.id === requestingFor)?.title}
          </h2>
          <div className="form-grid">
            <label>
              Developer / team lead
              <select
                value={requestForm.developerId}
                onChange={(e) =>
                  setRequestForm((f) => ({ ...f, developerId: e.target.value }))
                }
              >
                <option value="" disabled>
                  Select person…
                </option>
                {users
                  .filter((u) => u.role !== "PROJECT_MANAGER")
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Get update at (date &amp; time)
              <input
                type="datetime-local"
                value={requestForm.dueAt}
                onChange={(e) =>
                  setRequestForm((f) => ({ ...f, dueAt: e.target.value }))
                }
              />
            </label>
            <label className="form-wide">
              Note (optional)
              <input
                type="text"
                value={requestForm.note}
                onChange={(e) =>
                  setRequestForm((f) => ({ ...f, note: e.target.value }))
                }
                placeholder="e.g. Demo the progress so far"
              />
            </label>
          </div>
          <button className="btn btn-primary" type="submit">
            Schedule update request
          </button>
        </form>
      )}
    </div>
  );
}
