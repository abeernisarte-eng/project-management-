import React, { useEffect, useState } from "react";
import { api } from "../api/client.js";
import { useAuth } from "../context/AuthContext.jsx";

const STATUS_LABELS = {
  IN_PROGRESS: "In progress",
  COMPLETED: "Completed",
};

function ProjectForm({ onCreated }) {
  const { users, currentUser } = useAuth();
  const [show, setShow] = useState(false);
  const [form, setForm] = useState({
    name: "",
    description: "",
    startDate: "",
    endDate: "",
  });
  const [memberIds, setMemberIds] = useState([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  function update(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  function toggleMember(id) {
    setMemberIds((ids) =>
      ids.includes(id) ? ids.filter((m) => m !== id) : [...ids, id]
    );
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    if (!form.name) {
      setError("Project name is required.");
      return;
    }
    if (form.startDate && form.endDate && form.endDate < form.startDate) {
      setError("End date must be after the start date.");
      return;
    }
    setSaving(true);
    try {
      const created = await api.post("/projects", {
        name: form.name,
        description: form.description,
        startDate: form.startDate || null,
        endDate: form.endDate || null,
        memberIds,
      });
      onCreated(created);
      setForm({ name: "", description: "", startDate: "", endDate: "" });
      setMemberIds([]);
      setShow(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (!show) {
    return (
      <div className="page-actions">
        <button className="btn btn-primary" onClick={() => setShow(true)}>
          + Add project
        </button>
      </div>
    );
  }

  return (
    <form className="card task-form" onSubmit={handleSubmit}>
      <h2>New project</h2>
      <div className="form-grid">
        <label>
          Project name
          <input
            type="text"
            value={form.name}
            onChange={(e) => update("name", e.target.value)}
            placeholder="e.g. Website Redesign"
          />
        </label>

        <label>
          Start date
          <input
            type="date"
            value={form.startDate}
            onChange={(e) => update("startDate", e.target.value)}
          />
        </label>

        <label>
          End date
          <input
            type="date"
            value={form.endDate}
            onChange={(e) => update("endDate", e.target.value)}
          />
        </label>

        <label className="form-wide">
          Description
          <textarea
            rows={2}
            value={form.description}
            onChange={(e) => update("description", e.target.value)}
            placeholder="What is this project about?"
          />
        </label>

        <fieldset className="form-wide member-picker">
          <legend>Team members (Team Leads &amp; Developers only)</legend>
          <div className="member-list">
            {users
              .filter((u) => u.role !== "PROJECT_MANAGER")
              .map((u) => (
                <label key={u.id} className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={memberIds.includes(u.id)}
                    onChange={() => toggleMember(u.id)}
                  />
                  {u.name}
                </label>
              ))}
          </div>
        </fieldset>
      </div>

      {error && <p className="error-text">{error}</p>}

      <div className="form-actions">
        <button className="btn btn-primary" type="submit" disabled={saving}>
          {saving ? "Creating…" : "Create project"}
        </button>
        <button
          className="btn"
          type="button"
          onClick={() => {
            setShow(false);
            setError("");
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

export default function ProjectsPage() {
  const { users } = useAuth();
  const [projects, setProjects] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    Promise.all([api.get("/projects"), api.get("/tasks")])
      .then(([p, t]) => {
        setProjects(p);
        setTasks(t);
      })
      .catch((err) => setError(err.message));
  }, []);

  if (error)
    return <p className="error-text">Failed to load projects: {error}</p>;
  if (!projects) return <p className="muted">Loading projects…</p>;

  return (
    <div className="page">
      <h1>Projects</h1>

      <ProjectForm onCreated={(created) => setProjects((ps) => [...ps, created])} />

      <div className="project-grid">
        {projects.map((p) => {
          const projectTasks = tasks.filter((t) => t.projectId === p.id);
          const done = projectTasks.filter((t) => t.status === "DONE").length;
          const pct = projectTasks.length
            ? Math.round((done / projectTasks.length) * 100)
            : 0;
          const manager = users.find((u) => u.id === p.managerId);

          return (
            <div key={p.id} className="card project-card">
              <div className="project-card-header">
                <h2>{p.name}</h2>
                <span
                  className={`badge status-${
                    p.status === "COMPLETED" ? "done" : "in_progress"
                  }`}
                >
                  {STATUS_LABELS[p.status] || p.status}
                </span>
              </div>
              <p className="muted">{p.description}</p>
              <p className="muted">
                Manager: {manager ? manager.name : "—"}
              </p>
              <p className="muted">
                Assigned to:{" "}
                {p.memberIds.length
                  ? p.memberIds
                      .map((id) => users.find((u) => u.id === id)?.name)
                      .filter(Boolean)
                      .join(", ")
                  : "no one yet"}
              </p>
              <p className="muted">
                {new Date(p.startDate).toLocaleDateString()} –{" "}
                {new Date(p.endDate).toLocaleDateString()}
              </p>
              <div className="progress-track" title={`${done}/${projectTasks.length} tasks done`}>
                <div className="progress-fill" style={{ width: `${pct}%` }} />
              </div>
              <p className="muted">
                {done}/{projectTasks.length} tasks complete ({pct}%)
              </p>
            </div>
          );
        })}
      </div>

      {projects.length === 0 && (
        <p className="muted">No projects yet.</p>
      )}
    </div>
  );
}
