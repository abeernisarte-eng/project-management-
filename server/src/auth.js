// Real password-based authentication (bcrypt hashes + signed JWTs). Every
// protected route reads the caller's identity from the verified token, not
// from the request body, so a client can't just claim to be someone else.
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { users } = require("./store");
const { verifyPassword, hashPassword } = require("./auth-crypto");

// A fixed dev secret is fine for this project (no real secrets manager in
// scope); override with JWT_SECRET in a real deployment.
const JWT_SECRET = process.env.JWT_SECRET || "sptts-dev-secret-change-me";
const TOKEN_TTL = "12h";

function issueToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, {
    expiresIn: TOKEN_TTL,
  });
}

async function login(email, password) {
  const row = await users.findByEmailWithPassword(email);
  if (!row) return null;
  // PBKDF2 is the primary hash format (Workers-compatible). Legacy bcrypt
  // hashes verify here on Node only — on success they are transparently
  // rehashed to PBKDF2 so the Cloudflare Worker can verify them next time.
  let ok = await verifyPassword(password, row.passwordHash);
  if (ok === null) {
    ok = bcrypt.compareSync(password, row.passwordHash);
    if (ok) {
      await users.updatePasswordHash(row.id, await hashPassword(password));
    }
  }
  if (ok !== true) return null;
  const user = { id: row.id, name: row.name, email: row.email, role: row.role };
  return { user, token: issueToken(user) };
}

// Express middleware: requires a valid Bearer token, attaches req.user.
async function authenticate(req, res, next) {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) {
    return res
      .status(401)
      .json({ error: "Missing or invalid Authorization header" });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await users.findById(payload.sub);
    if (!user) return res.status(401).json({ error: "User no longer exists" });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// Express middleware factory: 403s unless req.user.role is one of `roles`.
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Not allowed for your role" });
    }
    next();
  };
}

module.exports = { login, authenticate, requireRole, JWT_SECRET };
