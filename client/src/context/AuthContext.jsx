import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
} from "react";
import { api, getToken, setToken } from "../api/client.js";

// Real email+password authentication: login() calls POST /api/auth/login,
// which checks a bcrypt hash server-side and returns a signed JWT. The token
// is kept in localStorage and attached to every request by api/client.js.
// `users` here is the directory of everyone in the org (for assignment
// pickers etc.), fetched once a session exists — it is not the login list.
const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [users, setUsers] = useState([]);
  const [currentUser, setCurrentUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const loadDirectory = useCallback(() => {
    return api
      .get("/users")
      .then(setUsers)
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;

    if (!getToken()) {
      setLoading(false);
      return;
    }

    api
      .get("/auth/me")
      .then(async (user) => {
        if (cancelled) return;
        setCurrentUser(user);
        await loadDirectory();
      })
      .catch(() => {
        if (!cancelled) setToken(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [loadDirectory]);

  const login = useCallback(
    async (email, password) => {
      setError(null);
      try {
        const { user, token } = await api.post("/auth/login", {
          email,
          password,
        });
        setToken(token);
        setCurrentUser(user);
        await loadDirectory();
        return true;
      } catch (err) {
        setError(err.message);
        return false;
      }
    },
    [loadDirectory]
  );

  const logout = useCallback(() => {
    setToken(null);
    setCurrentUser(null);
    setUsers([]);
  }, []);

  const value = {
    users,
    currentUser,
    role: currentUser ? currentUser.role : null,
    isAuthenticated: Boolean(currentUser),
    loading,
    error,
    login,
    logout,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
