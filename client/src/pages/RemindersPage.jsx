import React, { useEffect, useState } from "react";
import { api } from "../api/client.js";
import { useAuth } from "../context/AuthContext.jsx";

const TABS = [
  { id: "activity", label: "Task activity" },
  { id: "updates", label: "Update requests" },
  { id: "personal", label: "Personal reminders" },
];

function ActivityTab() {
  const [reminders, setReminders] = useState(null);
  const [showResolved, setShowResolved] = useState(false);
  const [error, setError] = useState(null);

  async function load() {
    try {
      const data = await api.get(
        `/reminders${showResolved ? "?resolved=true" : "?resolved=false"}`
      );
      setReminders(data);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
  }, [showResolved]);

  async function resolve(reminder) {
    setError(null);
    try {
      const updated = await api.patch(`/reminders/${reminder.id}`, {
        resolved: true,
      });
      if (!showResolved) {
        setReminders((rs) => rs.filter((r) => r.id !== updated.id));
      } else {
        setReminders((rs) => rs.map((r) => (r.id === updated.id ? updated : r)));
      }
    } catch (err) {
      setError(err.message);
    }
  }

  if (error) return <p className="error-text">Failed to load: {error}</p>;
  if (!reminders) return <p className="muted">Loading…</p>;

  return (
    <>
      <div className="filters">
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={showResolved}
            onChange={(e) => setShowResolved(e.target.checked)}
          />
          Show resolved
        </label>
      </div>

      <table className="table">
        <thead>
          <tr>
            <th>Employee</th>
            <th>Task / Project</th>
            <th>Status</th>
            <th>Last activity</th>
            <th>Reason</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {reminders.map((r) => (
            <tr key={r.id}>
              <td>
                <strong>{r.employeeName}</strong>
              </td>
              <td>
                {r.taskTitle}
                <div className="muted task-desc">{r.projectName}</div>
              </td>
              <td>
                <span className={`badge status-${r.status.toLowerCase()}`}>
                  {r.status.replace("_", " ")}
                </span>
              </td>
              <td className="muted">
                {new Date(r.lastActivityTime).toLocaleString()}
              </td>
              <td className="muted">{r.reason}</td>
              <td>
                {!r.resolved && (
                  <button className="btn" onClick={() => resolve(r)}>
                    Mark done
                  </button>
                )}
                {r.resolved && <span className="muted">Resolved ✓</span>}
              </td>
            </tr>
          ))}
          {reminders.length === 0 && (
            <tr>
              <td colSpan={6} className="muted">
                {showResolved
                  ? "No resolved reminders."
                  : "No pending reminders — everything has recent activity."}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}

function UpdateRequestsTab() {
  const { users } = useAuth();
  const [requests, setRequests] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [form, setForm] = useState({ taskId: "", developerId: "", dueAt: "", note: "" });
  const [msg, setMsg] = useState("");
  const [error, setError] = useState(null);

  async function load() {
    try {
      const [ur, t] = await Promise.all([
        api.get("/update-requests"),
        api.get("/tasks"),
      ]);
      setRequests(ur);
      setTasks(t);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function update(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  async function create(e) {
    e.preventDefault();
    setMsg("");
    setError(null);
    if (!form.taskId || !form.developerId || !form.dueAt) {
      setMsg("Pick a task, a person and a date/time.");
      return;
    }
    try {
      const created = await api.post("/update-requests", {
        taskId: form.taskId,
        developerId: form.developerId,
        dueAt: new Date(form.dueAt).toISOString(),
        note: form.note,
      });
      setRequests((rs) => [...(rs || []), created]);
      setMsg(
        `Scheduled: ${created.developerName} will be asked for an update on "${created.taskTitle}" at ${new Date(created.dueAt).toLocaleString()}.`
      );
      setForm({ taskId: "", developerId: "", dueAt: "", note: "" });
    } catch (err) {
      setError(err.message);
    }
  }

  async function fulfill(ur) {
    setError(null);
    try {
      const updated = await api.patch(`/update-requests/${ur.id}/fulfill`);
      setRequests((rs) => rs.map((r) => (r.id === updated.id ? updated : r)));
    } catch (err) {
      setError(err.message);
    }
  }

  if (error) return <p className="error-text">Failed to load: {error}</p>;
  if (!requests) return <p className="muted">Loading…</p>;

  return (
    <>
      <form className="card request-panel" onSubmit={create}>
        <h2>Schedule an update request</h2>
        <div className="form-grid">
          <label>
            Task
            <select value={form.taskId} onChange={(e) => update("taskId", e.target.value)}>
              <option value="" disabled>
                Select task…
              </option>
              {tasks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            Get update from
            <select
              value={form.developerId}
              onChange={(e) => update("developerId", e.target.value)}
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
            At (date &amp; time)
            <input
              type="datetime-local"
              value={form.dueAt}
              onChange={(e) => update("dueAt", e.target.value)}
            />
          </label>
          <label className="form-wide">
            Note (optional)
            <input
              type="text"
              value={form.note}
              onChange={(e) => update("note", e.target.value)}
              placeholder="e.g. Show a demo of the login flow"
            />
          </label>
        </div>
        {msg && <p className="muted">{msg}</p>}
        {error && <p className="error-text">{error}</p>}
        <button className="btn btn-primary" type="submit">
          Schedule update request
        </button>
      </form>

      <table className="table">
        <thead>
          <tr>
            <th>Get update from</th>
            <th>Task / Project</th>
            <th>Scheduled for</th>
            <th>Note</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {requests.map((ur) => {
            const due = ur.status === "PENDING" && new Date(ur.dueAt) <= new Date();
            return (
              <tr key={ur.id}>
                <td>
                  <strong>{ur.developerName}</strong>
                </td>
                <td>
                  {ur.taskTitle}
                  <div className="muted task-desc">{ur.projectName}</div>
                </td>
                <td className="muted">{new Date(ur.dueAt).toLocaleString()}</td>
                <td className="muted">{ur.note || "—"}</td>
                <td>
                  {ur.status === "PENDING" ? (
                    due ? (
                      <span className="badge status-blocked">Due now</span>
                    ) : (
                      <span className="badge status-in_progress">Pending</span>
                    )
                  ) : (
                    <span className="badge status-done">Fulfilled</span>
                  )}
                </td>
                <td>
                  {ur.status === "PENDING" && (
                    <button className="btn" onClick={() => fulfill(ur)}>
                      Got the update
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
          {requests.length === 0 && (
            <tr>
              <td colSpan={6} className="muted">
                No update requests scheduled yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}

function PersonalTab() {
  const [items, setItems] = useState(null);
  const [form, setForm] = useState({ title: "", dueAt: "", note: "" });
  const [msg, setMsg] = useState("");
  const [error, setError] = useState(null);

  async function load() {
    try {
      setItems(await api.get("/personal-reminders"));
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function update(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  async function create(e) {
    e.preventDefault();
    setMsg("");
    setError(null);
    if (!form.title || !form.dueAt) {
      setMsg("Give the reminder a title and a date/time.");
      return;
    }
    try {
      const created = await api.post("/personal-reminders", {
        title: form.title,
        dueAt: new Date(form.dueAt).toISOString(),
        note: form.note,
      });
      setItems((is) => [...(is || []), created]);
      setMsg(
        `Reminder set: "${created.title}" at ${new Date(created.dueAt).toLocaleString()}.`
      );
      setForm({ title: "", dueAt: "", note: "" });
    } catch (err) {
      setError(err.message);
    }
  }

  async function toggleDone(pr) {
    setError(null);
    try {
      const updated = await api.patch(`/personal-reminders/${pr.id}`, {
        done: !pr.done,
      });
      setItems((is) => is.map((r) => (r.id === updated.id ? updated : r)));
    } catch (err) {
      setError(err.message);
    }
  }

  if (error) return <p className="error-text">Failed to load: {error}</p>;
  if (!items) return <p className="muted">Loading…</p>;

  return (
    <>
      <form className="card request-panel" onSubmit={create}>
        <h2>New personal reminder</h2>
        <div className="form-grid">
          <label>
            What
            <input
              type="text"
              value={form.title}
              onChange={(e) => update("title", e.target.value)}
              placeholder="e.g. Client call, stand-up, 1:1 with Ben"
            />
          </label>
          <label>
            Remind me at (date &amp; time)
            <input
              type="datetime-local"
              value={form.dueAt}
              onChange={(e) => update("dueAt", e.target.value)}
            />
          </label>
          <label className="form-wide">
            Note (optional)
            <input
              type="text"
              value={form.note}
              onChange={(e) => update("note", e.target.value)}
              placeholder="e.g. Prepare the agenda"
            />
          </label>
        </div>
        {msg && <p className="muted">{msg}</p>}
        {error && <p className="error-text">{error}</p>}
        <button className="btn btn-primary" type="submit">
          Set reminder
        </button>
      </form>

      <table className="table">
        <thead>
          <tr>
            <th>Reminder</th>
            <th>Note</th>
            <th>When</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {items.map((pr) => {
            const due = !pr.done && new Date(pr.dueAt) <= new Date();
            return (
              <tr key={pr.id}>
                <td>
                  <strong>{pr.title}</strong>
                </td>
                <td className="muted">{pr.note || "—"}</td>
                <td className="muted">{new Date(pr.dueAt).toLocaleString()}</td>
                <td>
                  {pr.done ? (
                    <span className="badge status-done">Done</span>
                  ) : due ? (
                    <span className="badge status-blocked">Due now</span>
                  ) : (
                    <span className="badge status-in_progress">Upcoming</span>
                  )}
                </td>
                <td>
                  <button className="btn" onClick={() => toggleDone(pr)}>
                    {pr.done ? "Reopen" : "Mark done"}
                  </button>
                </td>
              </tr>
            );
          })}
          {items.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                No personal reminders yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}

export default function RemindersPage() {
  const [tab, setTab] = useState("activity");

  return (
    <div className="page">
      <h1>Reminders &amp; follow-ups</h1>

      <div className="tabs" role="tablist" aria-label="Reminder types">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`tab ${tab === t.id ? "active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "activity" && (
        <>
          <p className="muted">
            Generated automatically when a task in progress or blocked has had no
            update for more than 3 hours. Resolve one after following up with the
            employee.
          </p>
          <ActivityTab />
        </>
      )}
      {tab === "updates" && (
        <>
          <p className="muted">
            Schedule exactly when you want an update from a specific developer
            about a specific task. When the time arrives it appears in your
            notification bell until you mark it fulfilled.
          </p>
          <UpdateRequestsTab />
        </>
      )}
      {tab === "personal" && (
        <>
          <p className="muted">
            Your own reminders — meetings, calls, anything. You'll be notified
            at the time you set.
          </p>
          <PersonalTab />
        </>
      )}
    </div>
  );
}
