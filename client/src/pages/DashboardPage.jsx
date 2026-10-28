import React, { useEffect, useState } from "react";
import { api } from "../api/client.js";
import { useAuth } from "../context/AuthContext.jsx";

const STATUS_LABELS = {
  TODO: "To do",
  IN_PROGRESS: "In progress",
  BLOCKED: "Blocked",
  DONE: "Done",
};

function StatCard({ label, value }) {
  return (
    <div className="stat-card">
      <div className="stat-value">{value}</div>
      <div className="stat-label muted">{label}</div>
    </div>
  );
}

// Simple horizontal bar chart of hours logged per employee — hand-rolled
// SVG-free (plain divs) to avoid adding a charting dependency.
function HoursByEmployeeChart({ timelogs, users }) {
  const totals = {};
  for (const log of timelogs) {
    if (log.minutes == null) continue;
    totals[log.userId] = (totals[log.userId] || 0) + log.minutes;
  }
  const rows = Object.entries(totals)
    .map(([userId, minutes]) => ({
      name: users.find((u) => u.id === userId)?.name || "Unknown",
      hours: minutes / 60,
    }))
    .sort((a, b) => b.hours - a.hours);

  if (rows.length === 0) {
    return <p className="muted">No completed time logs yet.</p>;
  }

  const max = Math.max(...rows.map((r) => r.hours));

  return (
    <div className="bar-chart">
      {rows.map((r) => (
        <div key={r.name} className="bar-row">
          <span className="bar-label">{r.name}</span>
          <div className="bar-track">
            <div
              className="bar-fill"
              style={{ width: `${(r.hours / max) * 100}%` }}
            />
          </div>
          <span className="bar-value muted">{r.hours.toFixed(1)}h</span>
        </div>
      ))}
    </div>
  );
}

// Task-status distribution as a stacked bar, one segment per status.
function TaskStatusChart({ tasks }) {
  const counts = {};
  for (const t of tasks) counts[t.status] = (counts[t.status] || 0) + 1;
  const order = ["TODO", "IN_PROGRESS", "BLOCKED", "DONE"];
  const total = tasks.length;

  if (total === 0) return <p className="muted">No tasks yet.</p>;

  return (
    <div>
      <div className="stacked-bar">
        {order.map((status) => {
          const count = counts[status] || 0;
          if (count === 0) return null;
          return (
            <div
              key={status}
              className={`stacked-segment status-${status.toLowerCase()}`}
              style={{ width: `${(count / total) * 100}%` }}
              title={`${STATUS_LABELS[status]}: ${count}`}
            />
          );
        })}
      </div>
      <div className="legend">
        {order.map((status) => (
          <span key={status} className="legend-item">
            <span
              className={`legend-swatch status-${status.toLowerCase()}`}
            />
            {STATUS_LABELS[status]} ({counts[status] || 0})
          </span>
        ))}
      </div>
    </div>
  );
}

function WorkloadTable({ tasks, users, projects }) {
  const rows = users
    .map((u) => {
      const assigned = tasks.filter(
        (t) => t.assigneeId === u.id && t.status !== "DONE"
      );
      return { user: u, openTasks: assigned.length };
    })
    .filter((r) => r.openTasks > 0)
    .sort((a, b) => b.openTasks - a.openTasks);

  if (rows.length === 0) return <p className="muted">No open assignments.</p>;

  return (
    <table className="table">
      <thead>
        <tr>
          <th>Employee</th>
          <th>Role</th>
          <th>Open tasks</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.user.id}>
            <td>{r.user.name}</td>
            <td className="muted">{r.user.role.replace("_", " ").toLowerCase()}</td>
            <td>{r.openTasks}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function DashboardPage() {
  const { users } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    Promise.all([
      api.get("/projects"),
      api.get("/tasks"),
      api.get("/timelogs"),
      api.get("/reminders?resolved=false"),
    ])
      .then(([projects, tasks, timelogs, reminders]) =>
        setData({ projects, tasks, timelogs, reminders })
      )
      .catch((err) => setError(err.message));
  }, []);

  if (error) return <p className="error-text">Failed to load dashboard: {error}</p>;
  if (!data) return <p className="muted">Loading dashboard…</p>;

  const activeProjects = data.projects.filter(
    (p) => p.status === "IN_PROGRESS"
  ).length;
  const completedTasks = data.tasks.filter((t) => t.status === "DONE").length;
  const pendingReminders = data.reminders.length;
  const totalHours =
    data.timelogs.reduce((sum, l) => sum + (l.minutes || 0), 0) / 60;

  return (
    <div className="page">
      <h1>Dashboard</h1>

      <div className="stat-grid">
        <StatCard label="Total projects" value={data.projects.length} />
        <StatCard label="Active projects" value={activeProjects} />
        <StatCard label="Completed tasks" value={completedTasks} />
        <StatCard label="Pending reminders" value={pendingReminders} />
        <StatCard label="Hours logged" value={totalHours.toFixed(1)} />
      </div>

      <section className="card">
        <h2>Task status overview</h2>
        <TaskStatusChart tasks={data.tasks} />
      </section>

      <section className="card">
        <h2>Hours logged per employee</h2>
        <HoursByEmployeeChart timelogs={data.timelogs} users={users} />
      </section>

      <section className="card">
        <h2>Employee workload (open tasks)</h2>
        <WorkloadTable
          tasks={data.tasks}
          users={users}
          projects={data.projects}
        />
      </section>

      <section className="card">
        <h2>Pending reminders</h2>
        {pendingReminders === 0 ? (
          <p className="muted">Nothing needs following up.</p>
        ) : (
          <ul className="reminder-list">
            {data.reminders.slice(0, 5).map((r) => (
              <li key={r.id}>
                <strong>{r.employeeName}</strong> — {r.taskTitle} (
                {r.projectName}) ·{" "}
                <span className="muted">
                  idle since {new Date(r.lastActivityTime).toLocaleString()}
                </span>
              </li>
            ))}
            {pendingReminders > 5 && (
              <li className="muted">
                …and {pendingReminders - 5} more on the Reminders page.
              </li>
            )}
          </ul>
        )}
      </section>
    </div>
  );
}
