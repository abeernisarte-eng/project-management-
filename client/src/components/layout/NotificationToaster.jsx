import React from "react";
import { api } from "../../api/client.js";
import { useNotifications } from "../../context/NotificationContext.jsx";

const KIND_LABELS = {
  update: "Update request",
  reminder: "Reminder",
  idle: "Activity",
  expected: "Time alert",
  tracking: "Tracking",
  task: "Task update",
  deadline: "Deadline",
};

// The persistent notification stack. Every due reminder — personal or
// task-related — appears here within one poll cycle of becoming due and
// stays on screen until the user dismisses it with the ✕ button. No
// auto-dismiss timers exist on purpose: navigating away, switching pages,
// or waiting never removes a toast. The component lives at the app-shell
// level (above the router), so route changes never unmount it.
//
// Expected-time alerts (PM only) additionally carry Continue / Pause / Stop
// actions so the manager decides the session's fate right from the popup.
// None of them complete the task — completion stays a separate action.
export default function NotificationToaster() {
  const { active, dismiss } = useNotifications();

  if (active.length === 0) return null;

  async function actOnSession(n, action) {
    try {
      await api.post(`/timelogs/${n.raw.timelogId}/${action}`, {});
    } catch {
      // Server refused (already stopped, permissions, offline) — dismiss the
      // toast anyway; the tracking page shows the authoritative state.
    }
    dismiss(n.key);
  }

  return (
    <div className="toaster" role="region" aria-label="Active notifications">
      {active.map((n) => (
        <div key={n.key} className={`toast toast-${n.kind}`} role="status">
          <div className="toast-body">
            <span className="toast-kind">{KIND_LABELS[n.kind] || n.kind}</span>
            <strong className="toast-title">{n.title}</strong>
            <span className="toast-text">{n.body}</span>
            {n.kind === "expected" && (
              <span className="form-actions toast-actions">
                <button
                  className="btn btn-primary"
                  onClick={() => dismiss(n.key)}
                >
                  Continue
                </button>
                <button
                  className="btn"
                  onClick={() => actOnSession(n, "pause")}
                >
                  Pause
                </button>
                <button className="btn" onClick={() => actOnSession(n, "stop")}>
                  Stop
                </button>
              </span>
            )}
          </div>
          <button
            type="button"
            className="toast-close"
            aria-label={`Dismiss notification: ${n.title}`}
            onClick={() => dismiss(n.key)}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
}
