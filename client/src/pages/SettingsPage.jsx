import React, { useRef, useState } from "react";
import { useSettings } from "../context/SettingsContext.jsx";
import { TONES, previewSound } from "../lib/sounds.js";

// Settings tab (Project Manager): notification preferences + ringtone
// customization. Every change saves immediately to the backend
// (user_settings) and updates the live settings state, so gating and the
// ringtone take effect without a refresh.

const CATEGORY_ROWS = [
  {
    key: "expectedTime",
    title: "Expected duration reached",
    hint: "Alert when a tracked session reaches its expected duration.",
  },
  {
    key: "trackingActivity",
    title: "Tracking activity",
    hint: "Sessions started, paused, resumed, or stopped.",
  },
  {
    key: "taskUpdates",
    title: "Task assignments & status",
    hint: "Tasks assigned to you, or tasks whose status changes.",
  },
  {
    key: "taskDeadlines",
    title: "Task deadlines",
    hint: "A reminder on the day a task's due date arrives.",
  },
  {
    key: "reminders",
    title: "Reminders & follow-ups",
    hint: "Update requests, personal reminders, and idle-task alerts.",
  },
];

function Toggle({ checked, onChange, disabled, label }) {
  return (
    <span className="switch">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        aria-label={label}
      />
      <span className="switch-track" />
    </span>
  );
}

function permissionInfo() {
  if (typeof Notification === "undefined")
    return { state: "unsupported", text: "This browser does not support system notifications — in-app notifications still work." };
  if (Notification.permission === "granted")
    return { state: "granted", text: "System notifications are enabled for this browser." };
  if (Notification.permission === "denied")
    return {
      state: "denied",
      text: "System notifications are BLOCKED for this site. In-app notifications still work. To enable them: click the padlock/permissions icon in the address bar, or open browser Settings → Websites → Notifications and allow this site, then reload.",
    };
  return {
    state: "default",
    text: "System notifications are not enabled yet — use the “Enable system alerts” button in the top bar to allow them.",
  };
}

export default function SettingsPage() {
  const { settings, save, reset, loaded } = useSettings();
  const [msg, setMsg] = useState("");
  const [uploadMsg, setUploadMsg] = useState("");
  const fileRef = useRef(null);
  const volumeTimer = useRef(null);
  const permission = permissionInfo();

  async function apply(partial, message = "Preferences saved.") {
    try {
      await save(partial);
      setMsg(message);
    } catch (err) {
      setMsg(err.message);
    }
  }

  function onUploadFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadMsg("");
    if (!file.type.startsWith("audio/")) {
      setUploadMsg("Please choose an audio file (mp3, wav, ogg…).");
      return;
    }
    if (file.size > 450 * 1024) {
      setUploadMsg("Audio file is too large — maximum 450 KB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        await save({ sound: { customAudio: reader.result } });
        setUploadMsg(`Custom ringtone saved: ${file.name}`);
      } catch (err) {
        setUploadMsg(err.message);
      }
    };
    reader.onerror = () => setUploadMsg("Could not read that file.");
    reader.readAsDataURL(file);
  }

  function onVolumeChange(e) {
    const v = Number(e.target.value);
    // Optimistic local feedback; debounced persistence (the slider fires
    // continuously while dragging).
    setMsg("");
    if (volumeTimer.current) clearTimeout(volumeTimer.current);
    volumeTimer.current = setTimeout(() => {
      apply({ sound: { volume: v } }, `Volume set to ${v}%.`);
    }, 350);
  }

  async function onReset() {
    if (!window.confirm("Restore all notification settings to their defaults?"))
      return;
    try {
      await reset();
      setMsg("Settings restored to defaults.");
      setUploadMsg("");
    } catch (err) {
      setMsg(err.message);
    }
  }

  if (!loaded) return <p className="muted">Loading settings…</p>;

  const sound = settings.sound;

  return (
    <div className="page">
      <h1>Settings</h1>

      <section className="card">
        <h2>Notifications</h2>

        <div className="setting-row">
          <div className="setting-row-text">
            <span className="setting-row-title">Notifications</span>
            <span className="setting-row-hint">
              Master switch — when off, all application notifications are
              suppressed, regardless of the categories below.
            </span>
          </div>
          <Toggle
            label="Enable notifications"
            checked={settings.masterEnabled}
            onChange={(v) => apply({ masterEnabled: v }, v ? "Notifications on." : "Notifications off.")}
          />
        </div>

        <div className="setting-row">
          <div className="setting-row-text">
            <span className="setting-row-title">System notifications</span>
            <span className="setting-row-hint">{permission.text}</span>
          </div>
          <span className={`badge ${permission.state === "granted" ? "status-done" : "priority-medium"}`}>
            {permission.state === "granted" ? "Allowed" : permission.state === "denied" ? "Blocked" : "Not enabled"}
          </span>
        </div>

        {CATEGORY_ROWS.map((row) => (
          <div key={row.key} className="setting-row" style={!settings.masterEnabled ? { opacity: 0.5 } : undefined}>
            <div className="setting-row-text">
              <span className="setting-row-title">{row.title}</span>
              <span className="setting-row-hint">{row.hint}</span>
            </div>
            <Toggle
              label={row.title}
              disabled={!settings.masterEnabled}
              checked={settings.categories[row.key] !== false}
              onChange={(v) => apply({ categories: { [row.key]: v } })}
            />
          </div>
        ))}
      </section>

      <section className="card">
        <h2>Notification sound</h2>

        <div className="setting-row">
          <div className="setting-row-text">
            <span className="setting-row-title">Sound</span>
            <span className="setting-row-hint">
              Play the selected ringtone for new notifications — independent of
              the visual notifications above.
            </span>
          </div>
          <Toggle
            label="Enable notification sound"
            checked={sound.enabled}
            onChange={(v) => apply({ sound: { enabled: v } }, v ? "Sound on." : "Sound off.")}
          />
        </div>

        <div className="setting-row" style={!sound.enabled ? { opacity: 0.5 } : undefined}>
          <div className="setting-row-text">
            <span className="setting-row-title">Ringtone</span>
            <span className="setting-row-hint">
              {sound.customAudio
                ? "A custom uploaded ringtone is active. Remove it below to use the built-in tones."
                : "Pick the tone played for new notifications."}
            </span>
          </div>
          <div className="form-actions">
            <select
              aria-label="Notification ringtone"
              value={sound.tone}
              disabled={!sound.enabled || Boolean(sound.customAudio)}
              onChange={(e) => apply({ sound: { tone: e.target.value } })}
            >
              {TONES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <button
              className="btn"
              type="button"
              disabled={!sound.enabled}
              onClick={() => previewSound(sound)}
            >
              Play preview
            </button>
          </div>
        </div>

        <div className="setting-row" style={!sound.enabled ? { opacity: 0.5 } : undefined}>
          <div className="setting-row-text">
            <span className="setting-row-title">Volume</span>
            <span className="setting-row-hint">Applies to the ringtone and preview.</span>
          </div>
          <input
            type="range"
            className="volume"
            min="0"
            max="100"
            value={sound.volume ?? 60}
            disabled={!sound.enabled}
            onChange={onVolumeChange}
            aria-label="Notification volume"
          />
        </div>

        <div className="setting-row" style={!sound.enabled ? { opacity: 0.5 } : undefined}>
          <div className="setting-row-text">
            <span className="setting-row-title">Custom ringtone</span>
            <span className="setting-row-hint">
              Upload an audio file (mp3, wav, ogg — max 450 KB) to use as your
              notification sound.
            </span>
            {uploadMsg && <span className="muted task-desc">{uploadMsg}</span>}
          </div>
          <div className="form-actions">
            <input
              ref={fileRef}
              type="file"
              accept="audio/*"
              style={{ display: "none" }}
              onChange={onUploadFile}
            />
            <button
              className="btn"
              type="button"
              disabled={!sound.enabled}
              onClick={() => fileRef.current?.click()}
            >
              Upload…
            </button>
            {sound.customAudio && (
              <button
                className="btn"
                type="button"
                disabled={!sound.enabled}
                onClick={async () => {
                  await apply({ sound: { customAudio: null } }, "Custom ringtone removed.");
                  setUploadMsg("");
                  if (fileRef.current) fileRef.current.value = "";
                }}
              >
                Remove
              </button>
            )}
          </div>
        </div>
      </section>

      <section className="card">
        <h2>Reset</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Restores the master switch, all categories, and the sound settings —
          including any custom ringtone — to their defaults.
        </p>
        <button className="btn" type="button" onClick={onReset}>
          Reset to defaults
        </button>
      </section>

      {msg && <p className="muted">{msg}</p>}
    </div>
  );
}
