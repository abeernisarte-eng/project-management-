import React from "react";
import { useAuth } from "./context/AuthContext.jsx";
import { SettingsProvider } from "./context/SettingsContext.jsx";
import { NotificationProvider } from "./context/NotificationContext.jsx";
import LoginPage from "./pages/LoginPage.jsx";
import AppShell from "./components/layout/AppShell.jsx";

export default function App() {
  const { isAuthenticated } = useAuth();
  // Settings lives outside the notification provider so toggling a
  // preference re-gates notifications instantly. Both live inside the
  // authenticated shell: their state (polling, toasts, dismissals,
  // preferences in flight) belongs to a signed-in session, and logging out
  // tears them down cleanly.
  return isAuthenticated ? (
    <SettingsProvider>
      <NotificationProvider>
        <AppShell />
      </NotificationProvider>
    </SettingsProvider>
  ) : (
    <LoginPage />
  );
}
