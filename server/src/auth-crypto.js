// Password hashing shared by the Express server (Node) and the Cloudflare
// Worker (workerd) — implemented with Web Crypto (crypto.subtle), which both
// runtimes provide, so hashes created on either side verify on both.
//
// bcrypt was dropped for the Worker path: bcryptjs is pure JS but its
// synchronous work deadlocks the Workers runtime (verified empirically).
//
// Stored format: pbkdf2$<iterations>$<saltB64>$<hashB64> (PBKDF2-SHA-256,
// 256-bit key). Legacy bcrypt hashes ("$2...") verify on Node only —
// auth.js rehashes them to this format transparently on successful login.

const ITERATIONS = 100000;

function bufToB64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function deriveBits(password, salt, iterations, lengthBits) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations },
      key,
      lengthBits
    )
  );
}

// Returns the stored-format hash string for a plaintext password.
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await deriveBits(password, salt, ITERATIONS, 256);
  return `pbkdf2$${ITERATIONS}$${bufToB64(salt)}$${bufToB64(bits)}`;
}

// Verifies a plaintext password against a stored hash.
//   true  -> password matches
//   false -> password does not match
//   null  -> stored hash is in an unknown/legacy format this runtime cannot
//            verify (callers decide, e.g. Node falls back to bcrypt).
async function verifyPassword(password, stored) {
  if (typeof stored !== "string" || !stored.startsWith("pbkdf2$")) return null;
  const [, iterStr, saltB64, hashB64] = stored.split("$");
  const iterations = Number(iterStr);
  if (!Number.isInteger(iterations) || iterations < 1) return false;
  let expected;
  let salt;
  try {
    salt = b64ToBytes(saltB64);
    expected = b64ToBytes(hashB64);
  } catch {
    return false;
  }
  const bits = await deriveBits(password, salt, iterations, expected.length * 8);
  // Constant-time comparison.
  let diff = bits.length ^ expected.length;
  for (let i = 0; i < bits.length && i < expected.length; i++) {
    diff |= bits[i] ^ expected[i];
  }
  return diff === 0;
}

module.exports = { hashPassword, verifyPassword, ITERATIONS };
