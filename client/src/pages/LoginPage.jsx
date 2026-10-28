import React, { useState } from "react";
import { useAuth } from "../context/AuthContext.jsx";

// Real email + password login, checked server-side against a bcrypt hash
// (see server/src/auth.js). Every seeded demo account shares the same
// password until someone changes it; there is no self-signup flow in scope.
const DEMO_ACCOUNTS = [
  { email: "alice.morgan@example.com", role: "Project Manager" },
  { email: "ben.carter@example.com", role: "Team Lead" },
  { email: "chloe.diaz@example.com", role: "Employee" },
  { email: "david.osei@example.com", role: "Employee" },
  { email: "emma.nilsson@example.com", role: "Employee" },
];

export default function LoginPage() {
  const { login, error } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [formError, setFormError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setFormError("");
    if (!email || !password) {
      setFormError("Enter your email and password.");
      return;
    }
    setSubmitting(true);
    // login() reports its own failure message through AuthContext — a network
    // problem and a wrong password need different wording — so don't replace
    // it with a hardcoded one here.
    await login(email, password);
    setSubmitting(false);
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-brand">
          <svg
            className="brand-mark"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <defs>
              <linearGradient id="login-brand-g" x1="0" y1="0" x2="24" y2="24">
                <stop offset="0" stopColor="#6366f1" />
                <stop offset="1" stopColor="#8b5cf6" />
              </linearGradient>
            </defs>
            <rect x="1" y="1" width="22" height="22" rx="6" fill="url(#login-brand-g)" />
            <path
              d="M5 12h3l2.5-5 3 10L16 12h3"
              stroke="#fff"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span>SPTTS</span>
        </div>
        <h1>Smart Project &amp; Time Tracker</h1>
        <p className="login-subtitle">Sign in to continue.</p>

        <form onSubmit={handleSubmit} className="login-form">
          <label htmlFor="login-email">Email</label>
          <input
            id="login-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            autoComplete="username"
          />

          <label htmlFor="login-password">Password</label>
          <input
            id="login-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            autoComplete="current-password"
          />

          {(formError || error) && (
            <p className="error-text">{formError || error}</p>
          )}

          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? "Signing in…" : "Log in"}
          </button>
        </form>

        <div className="login-demo-accounts">
          <p className="muted">Demo accounts (password: password123)</p>
          <ul>
            {DEMO_ACCOUNTS.map((a) => (
              <li key={a.email}>
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => {
                    setEmail(a.email);
                    setPassword("password123");
                  }}
                >
                  {a.email}
                </button>{" "}
                <span className="muted">— {a.role}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
