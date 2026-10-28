import React from "react";
import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../../context/AuthContext.jsx";
import Sidebar from "./Sidebar.jsx";
import Topbar from "./Topbar.jsx";
import NotificationToaster from "./NotificationToaster.jsx";
import SettingsPage from "../../pages/SettingsPage.jsx";
import DashboardPage from "../../pages/DashboardPage.jsx";
import ProjectsPage from "../../pages/ProjectsPage.jsx";
import TasksPage from "../../pages/TasksPage.jsx";
import TimeTrackingPage from "../../pages/TimeTrackingPage.jsx";
import RemindersPage from "../../pages/RemindersPage.jsx";

// Route-level access control. Only routes the current role is allowed to see
// are rendered; anything else falls back to their home page. Settings is a
// Project Manager page (the tab manages PM notification preferences).
const ROLE_ROUTES = {
  PROJECT_MANAGER: [
    "/dashboard",
    "/projects",
    "/tasks",
    "/time-tracking",
    "/reminders",
    "/settings",
  ],
  TEAM_LEAD: ["/dashboard", "/projects", "/tasks", "/time-tracking"],
  EMPLOYEE: ["/dashboard", "/tasks", "/time-tracking"],
};

function homeFor(role) {
  return role === "PROJECT_MANAGER" ? "/dashboard" : "/tasks";
}

// Contextual header titles — the topbar shows where you are, not who you are.
const PAGE_TITLES = {
  "/dashboard": "Dashboard",
  "/projects": "Projects",
  "/tasks": "Tasks",
  "/time-tracking": "Time Tracking",
  "/reminders": "Reminders",
  "/settings": "Settings",
};

export default function AppShell() {
  const { currentUser, logout } = useAuth();
  const { pathname } = useLocation();
  const allowed = ROLE_ROUTES[currentUser.role] || [];

  return (
    <div className="app-shell">
      <Sidebar links={allowed} user={currentUser} onLogout={logout} />
      <div className="app-main">
        <Topbar title={PAGE_TITLES[pathname] || "Smart Project & Time Tracker"} />
        {/* Persistent reminder toasts — outside the router so navigation
            never unmounts them. */}
        <NotificationToaster />
        <main className="app-content">
          <Routes>
            <Route
              path="/"
              element={<Navigate to={homeFor(currentUser.role)} replace />}
            />
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/projects" element={<ProjectsPage />} />
            <Route path="/tasks" element={<TasksPage />} />
            <Route path="/time-tracking" element={<TimeTrackingPage />} />
            <Route path="/reminders" element={<RemindersPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route
              path="*"
              element={<Navigate to={homeFor(currentUser.role)} replace />}
            />
          </Routes>
        </main>
      </div>
    </div>
  );
}
