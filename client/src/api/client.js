// Thin fetch wrapper for the Express backend. Requests go through the Vite
// dev proxy (see vite.config.js), so relative "/api/..." paths are enough.
const BASE_URL = "/api";
const TOKEN_KEY = "sptts.token";

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

async function request(path, { method = "GET", body } = {}) {
  const token = getToken();
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  if (token) headers["Authorization"] = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    // The request never left the browser: refused connection, DNS failure,
    // offline. Keep this distinct from a server-authored error so callers can
    // show an accurate message instead of blaming the user's credentials.
    throw new Error(
      "Cannot reach the server. Check that it is running and try again."
    );
  }

  let data = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!res.ok) {
    if (res.status === 401) setToken(null);
    const message =
      (data && data.error) ||
      (res.status >= 500
        ? "The server hit an unexpected error. Try again in a moment."
        : `Request failed with status ${res.status}`);
    throw new Error(message);
  }

  return data;
}

export const api = {
  get: (path) => request(path),
  post: (path, body) => request(path, { method: "POST", body }),
  patch: (path, body) => request(path, { method: "PATCH", body }),
  del: (path) => request(path, { method: "DELETE" }),
};
