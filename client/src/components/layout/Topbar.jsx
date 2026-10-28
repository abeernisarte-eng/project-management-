import React, { useEffect, useRef, useState } from "react";
import { useNotifications, playChime } from "../../context/NotificationContext.jsx";

// Slim contextual header: current page title on the left, the notification
// bell on the right. Brand, navigation, and the signed-in identity live in
// the sidebar — the header only carries what changes with the page.
//
// The bell consumes the shared NotificationProvider (the same single poll
// that feeds the persistent toaster), so the badge, the dropdown, and the
// toasts can never disagree about what is due.
export default function Topbar({ title }) {
  const { due, refresh } = useNotifications();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  // "default" | "granted" | "denied" | "unsupported" — surfaced as button
  // states so the outcome of a click is always visible. Browsers (Safari in
  // particular) only accept the permission request from a user gesture and
  // give no feedback when it's ignored, which is why the button handles and
  // reports every outcome explicitly.
  const [systemAlerts, setSystemAlerts] = useState(
    typeof Notification !== "undefined" ? Notification.permission : "unsupported"
  );

  // Cross-browser permission request: modern browsers return a Promise from
  // Notification.requestPermission(); older Safari only supports the callback
  // form. Wrap both so one click always produces a definitive result.
  function requestPermissionOnce() {
    return new Promise((resolve) => {
      try {
        const maybe = Notification.requestPermission((result) => resolve(result));
        if (maybe && typeof maybe.then === "function") maybe.then(resolve);
      } catch {
        resolve(Notification.permission);
      }
    });
  }

  async function enableSystemAlerts() {
    const result = await requestPermissionOnce();
    setSystemAlerts(result);
    if (result === "granted") {
      // Immediate proof it works: a real OS notification + the chime.
      try {
        new Notification("Smart Project & Time Tracker", {
          body: "System alerts are on — reminders will appear here.",
          tag: "alerts-enabled",
        });
      } catch {
        // Constructor unsupported; the permission is still granted.
      }
      playChime();
    }
  }

  // Close the dropdown when clicking anywhere outside it.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const count = due.length;

  function alertButton() {
    if (systemAlerts === "granted") return null;
    if (systemAlerts === "denied") {
      return (
        <button
          className="btn"
          disabled
          title="Your browser has blocked notifications for this site. Allow them via the padlock/permissions icon in the address bar, or browser Settings → Websites → Notifications."
        >
          Alerts blocked
        </button>
      );
    }
    if (systemAlerts === "unsupported") {
      return (
        <button
          className="btn"
          disabled
          title="This browser does not support system notifications."
        >
          Alerts unavailable
        </button>
      );
    }
    return (
      <button
        className="btn"
        onClick={enableSystemAlerts}
        title="Allow a sound + operating-system notifications, even when this tab is in the background"
      >
        Enable system alerts
      </button>
    );
  }

  return (
    <header className="topbar">
      <div className="topbar-title">{title}</div>
      <div className="topbar-right">
        {alertButton()}
        <div className="bell-wrap" ref={wrapRef}>
          <button
            className="bell-btn"
            aria-label={`Notifications: ${count} due`}
            aria-expanded={open}
            onClick={() => {
              setOpen((o) => !o);
              refresh();
            }}
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
              <path d="M13.7 21a2 2 0 0 1-3.4 0" />
            </svg>
            {count > 0 && <span className="bell-badge">{count}</span>}
          </button>

          {open && (
            <div className="bell-dropdown" role="dialog" aria-label="Notifications">
              <div className="bell-head">Due now</div>

              {count === 0 && (
                <p className="muted bell-empty">Nothing due right now.</p>
              )}

              {due.map((n) => (
                <NotifRow key={n.key} n={n} />
              ))}

              <div className="bell-foot">
                Manage everything on the{" "}
                <strong>Reminders &amp; follow-ups</strong> page.
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

// Richer rendering in the dropdown, per kind, using the server fields kept
// on the normalized item's `raw`.
function NotifRow({ n }) {
  const r = n.raw;

  if (n.kind === "update") {
    return (
      <div className="notif-item">
        <span className="badge status-blocked">Update</span>
        <div>
          Time to get an update from <strong>{r.developerName}</strong> about{" "}
          <strong>{r.taskTitle}</strong>
          {r.note && <div className="muted task-desc">{r.note}</div>}
          <div className="muted task-desc">
            Scheduled {new Date(r.dueAt).toLocaleString()} · {r.projectName}
          </div>
        </div>
      </div>
    );
  }

  if (n.kind === "reminder") {
    return (
      <div className="notif-item">
        <span className="badge status-in_progress">Reminder</span>
        <div>
          <strong>{r.title}</strong>
          <div className="muted task-desc">
            {new Date(r.dueAt).toLocaleString()}
            {r.note ? ` · ${r.note}` : ""}
          </div>
        </div>
      </div>
    );
  }

  if (n.kind === "expected") {
    return (
      <div className="notif-item">
        <span className="badge priority-medium">Expected</span>
        <div>
          <strong>{r.taskTitle}</strong> reached its expected time
          <div className="muted task-desc">
            {r.projectName} · {r.developerName} · expected {r.expectedMinutes}m,
            elapsed {r.elapsedMinutes}m
          </div>
        </div>
      </div>
    );
  }

  if (n.kind === "tracking" || n.kind === "task" || n.kind === "deadline") {
    const badge =
      n.kind === "deadline"
        ? "priority-medium"
        : n.kind === "task"
          ? "status-in_progress"
          : "status-done";
    const label =
      n.kind === "deadline" ? "Deadline" : n.kind === "task" ? "Task" : "Tracking";
    return (
      <div className="notif-item">
        <span className={`badge ${badge}`}>{label}</span>
        <div>
          <strong>{r.title}</strong>
          <div className="muted task-desc">{r.body}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="notif-item">
      <span className="badge status-in_progress">Activity</span>
      <div>
        <strong>{r.employeeName}</strong> hasn't updated{" "}
        <strong>{r.taskTitle}</strong> in over 3 hours
        <div className="muted task-desc">
          {r.projectName} · {r.status.replace("_", " ")}
        </div>
      </div>
    </div>
  );
}
