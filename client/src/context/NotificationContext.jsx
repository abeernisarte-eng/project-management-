import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api, getToken } from "../api/client.js";
import { useSettings } from "./SettingsContext.jsx";
import { playNotificationSound, primeAudio } from "../lib/sounds.js";

// How often we ask the server what is due right now. A reminder that reaches
// its scheduled time surfaces within one poll cycle, whichever kind it is.
const POLL_MS = 30 * 1000;

// Desktop notifications re-fire for an item at this interval while it stays
// due, so it is visible even when the tab is in the background. In-app toasts
// (the persistent stack) never re-fire and never auto-dismiss — they leave
// only via their ✕ button.
const RENOTIFY_MS = 15 * 60 * 1000;

const NotificationContext = createContext(null);

// kind -> Settings-tab category. Items whose category is switched off are
// suppressed client-side (instant effect) and server-side (persistence).
const KIND_CATEGORY = {
  update: "reminders",
  reminder: "reminders",
  idle: "reminders",
  expected: "expectedTime",
  tracking: "trackingActivity",
  task: "taskUpdates",
  deadline: "taskDeadlines",
};

function categoryEnabled(item, settings) {
  if (!settings) return true;
  if (!settings.masterEnabled) return false;
  const cat = KIND_CATEGORY[item.kind];
  return cat ? settings.categories[cat] !== false : true;
}

function notifyDesktop(key, title, body, lastNotifiedRef, force = false) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") {
    return;
  }
  const last = lastNotifiedRef.current[key];
  if (!force && last && Date.now() - last < RENOTIFY_MS) return;
  lastNotifiedRef.current[key] = Date.now();
  try {
    // requireInteraction keeps the OS notification on screen until the user
    // deals with it, where the operating system supports it.
    new Notification(title, { body, tag: key, requireInteraction: true });
  } catch {
    try {
      new Notification(title, { body, tag: key });
    } catch {
      // Some environments throw even after permission === "granted"; failing
      // silently is fine — the in-app toast is the source of truth.
    }
  }
}

// One normalized shape for every notification kind so the toaster and the
// bell can treat them identically. `raw` keeps the server fields the bell
// dropdown uses for its richer rendering.
function normalize(data) {
  const out = [];
  for (const ur of data?.updateRequests || []) {
    out.push({
      key: `ur:${ur.id}`,
      kind: "update",
      title: "Time to get an update",
      body: `${ur.developerName} — ${ur.taskTitle} (${ur.projectName})`,
      raw: ur,
    });
  }
  for (const pr of data?.personalReminders || []) {
    out.push({
      key: `pr:${pr.id}`,
      kind: "reminder",
      title: `Reminder: ${pr.title}`,
      body: pr.note || new Date(pr.dueAt).toLocaleString(),
      raw: pr,
    });
  }
  for (const ir of data?.idleReminders || []) {
    out.push({
      key: `ir:${ir.id}`,
      kind: "idle",
      title: "Task has gone quiet",
      body: `${ir.employeeName} — ${ir.taskTitle} (${ir.projectName})`,
      raw: ir,
    });
  }
  // Expected-duration alerts (PM only): elapsed time reached the threshold.
  for (const et of data?.expectedTime || []) {
    out.push({
      key: `et:${et.timelogId}`,
      kind: "expected",
      title: "Expected time reached",
      body: `${et.taskTitle} (${et.projectName}) — ${et.developerName}. Expected ${et.expectedMinutes}m, elapsed ${et.elapsedMinutes}m.`,
      raw: et,
    });
  }
  // Activity events (tracking changes, task updates, deadlines) from the
  // server-side event stream.
  for (const ev of data?.activity || []) {
    out.push({
      key: `ev:${ev.id}`,
      kind: ev.kind,
      title: ev.title,
      body: ev.body,
      raw: ev,
    });
  }
  return out;
}

// Owns the single poll for everything due. Two consumers hang off it:
//  - NotificationToaster: due items (after settings gating) not yet dismissed,
//    rendered as persistent toasts that survive route changes and only leave
//    via ✕.
//  - Topbar bell: the same gated list.
export function NotificationProvider({ children }) {
  const { settings } = useSettings();
  const [rawDue, setRawDue] = useState([]);
  // Session-level dismissal: once you ✕ a reminder it stays gone for this
  // session, even though the server keeps reporting it due. A fresh login
  // starts a clean slate.
  const dismissedRef = useRef(new Set());
  const lastNotifiedRef = useRef({});
  // Keys seen on the previous poll — lets us detect genuinely NEW arrivals
  // (sound + immediate OS notification) vs. the backlog on page load.
  const knownKeysRef = useRef(null);
  // Latest settings for the poll callback without re-subscribing the timer.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const load = useCallback(() => {
    if (!getToken()) return;
    api
      .get("/notifications")
      .then((data) => {
        const items = normalize(data);
        const live = settingsRef.current;
        // The first load only establishes the baseline: sound and OS
        // notifications fire for items that ARRIVE while the app is open,
        // not for the backlog that was already due when the page loaded.
        const isFirstLoad = knownKeysRef.current === null;
        const fresh = isFirstLoad
          ? []
          : items.filter((n) => !knownKeysRef.current.has(n.key));
        knownKeysRef.current = new Set(items.map((n) => n.key));
        setRawDue(items);
        for (const n of fresh) {
          if (!categoryEnabled(n, live)) continue;
          playNotificationSound(live?.sound);
          notifyDesktop(n.key, n.title, n.body, lastNotifiedRef, true);
        }
        // Items that stay due keep re-pinging as system notifications on the
        // slower reminder cadence, so they're visible with the tab in the
        // background.
        for (const n of items) {
          if (!categoryEnabled(n, live)) continue;
          notifyDesktop(n.key, n.title, n.body, lastNotifiedRef);
        }
      })
      .catch(() => {
        // Server unreachable — the toasts already on screen stay; the next
        // poll retries.
      });
  }, []);

  // Prime the audio context on the first user interaction so the ringtone is
  // allowed to play later (browsers block audio without a prior gesture).
  useEffect(() => {
    document.addEventListener("pointerdown", primeAudio, { once: true });
    return () => document.removeEventListener("pointerdown", primeAudio);
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const dismiss = useCallback((key) => {
    dismissedRef.current.add(key);
    // New array identity so the active memo recomputes.
    setRawDue((prev) => [...prev]);
  }, []);

  // Gating applies at render time with the live settings object, so toggling
  // a category in Settings takes effect immediately — no refresh, no waiting
  // for the next poll.
  const gatedDue = useMemo(
    () => rawDue.filter((n) => categoryEnabled(n, settings)),
    [rawDue, settings]
  );

  const active = useMemo(
    () => gatedDue.filter((n) => !dismissedRef.current.has(n.key)),
    [gatedDue]
  );

  const value = { due: gatedDue, active, dismiss, refresh: load };

  return (
    <NotificationContext.Provider value={value}>
      {children}
    </NotificationContext.Provider>
  );
}

export function useNotifications() {
  const ctx = useContext(NotificationContext);
  if (!ctx) {
    throw new Error("useNotifications must be used within a NotificationProvider");
  }
  return ctx;
}

// Confirmation chime used by the Topbar right after system alerts are
// enabled. Independent of the sound on/off toggle — the user explicitly
// asked for audible feedback by clicking.
export function playChime() {
  playNotificationSound({ enabled: true, tone: "chime", volume: 60 });
}
