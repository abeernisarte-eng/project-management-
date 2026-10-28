import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { api, getToken } from "../api/client.js";

// Per-account notification preferences for the Settings tab, persisted in
// the backend (user_settings table) so they survive refreshes and reopenings.
// Exposes the live settings object + save(); saving updates state instantly
// so notification gating and the selected ringtone take effect without a
// page refresh (the next poll already respects the new values server-side).

const DEFAULT_SETTINGS = {
  masterEnabled: true,
  categories: {
    expectedTime: true,
    trackingActivity: true,
    taskUpdates: true,
    taskDeadlines: true,
    reminders: true,
  },
  sound: { enabled: true, tone: "chime", volume: 60, customAudio: null },
};

const SettingsContext = createContext(null);

export function SettingsProvider({ children }) {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!getToken()) return;
    api
      .get("/settings/notifications")
      .then((data) => setSettings(data))
      .catch(() => {
        // Server unreachable — defaults stay in effect; the Settings page
        // save will retry.
      })
      .finally(() => setLoaded(true));
  }, []);

  // Partial deep-merge save: PATCH-like semantics against the stored blob.
  const save = useCallback(async (partial) => {
    setSettings((prev) => ({
      ...prev,
      masterEnabled:
        partial.masterEnabled !== undefined ? partial.masterEnabled : prev.masterEnabled,
      categories: { ...prev.categories, ...(partial.categories || {}) },
      sound: { ...prev.sound, ...(partial.sound || {}) },
    }));
    const saved = await api.put("/settings/notifications", partial);
    setSettings(saved);
    return saved;
  }, []);

  const reset = useCallback(async () => {
    const saved = await api.put("/settings/notifications", {
      masterEnabled: DEFAULT_SETTINGS.masterEnabled,
      categories: DEFAULT_SETTINGS.categories,
      sound: {
        enabled: DEFAULT_SETTINGS.sound.enabled,
        tone: DEFAULT_SETTINGS.sound.tone,
        volume: DEFAULT_SETTINGS.sound.volume,
        customAudio: null,
      },
    });
    setSettings(saved);
    return saved;
  }, []);

  const value = useMemo(
    () => ({ settings, loaded, save, reset, defaults: DEFAULT_SETTINGS }),
    [settings, loaded, save, reset]
  );

  return (
    <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
  );
}

export function useSettings() {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used within a SettingsProvider");
  return ctx;
}
