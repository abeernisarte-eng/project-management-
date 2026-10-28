# Deploying SPTTS to Cloudflare

Target architecture (all on Cloudflare):

| Layer | Service | What runs |
|---|---|---|
| Frontend | **Cloudflare Pages** | `client/dist` (Vite build, static SPA) |
| Backend API | **Pages Functions** (`functions/api/[[route]].js`) | Hono app (`functions/_app.js`) reusing `server/src/store.js` |
| Database | **Neon Postgres** (or any Postgres) + **Hyperdrive** binding | `pg` over Cloudflare's connection pooler |

Everything is already implemented and verified locally (`npm run deploy:preview`
runs the real Worker runtime against a Postgres database — health, login,
notifications and the full settings flow were tested through it).

## 1. Prerequisites

- A Cloudflare account (free plan works; paid is safer for login CPU)
- Node 18+
- A hosted Postgres. Recommended: **Neon** — the app was originally built for
  it. Copy the connection string (looks like
  `postgresql://user:pass@ep-xxx.region.aws.neon.tech/neondb?sslmode=require`)

## 2. Prepare the database (one time)

```bash
# applies schema + seeds demo data when empty (idempotent)
npm run deploy:setup-db -- "postgresql://user:pass@host/db?sslmode=require"

# only needed if the database still holds legacy bcrypt password hashes:
node server/scripts/migrate-auth.js "postgresql://user:pass@host/db?sslmode=require"
```

Note: bcrypt hashes cannot be verified inside the Workers runtime, so
`migrate-auth.js` resets any non-PBKDF2 password to the demo default
(`password123`). On a fresh `setup-db` database every user already gets
PBKDF2 of the default password — nothing else to do.

## 3. Cloudflare setup (one time)

```bash
npx wrangler login

# recommended: Hyperdrive pooler for the database
npx wrangler hyperdrive create sptts-db \
  --connection-string="postgresql://user:pass@host/db?sslmode=require"
# -> copy the returned resource id into wrangler.toml:
#    [[hyperdrive]]
#    binding = "HYPERDRIVE"
#    id = "<id>"
```

If you skip Hyperdrive, set the connection string as a secret instead:

```bash
npx wrangler pages secret put DATABASE_URL
```

JWT signing secret (never commit it):

```bash
npx wrangler pages secret put JWT_SECRET
```

## 4. Deploy

```bash
npm run deploy:pages
# = copies server/src into functions/_lib, builds the client,
#   and deploys dist + functions to Cloudflare Pages
```

First deploy asks to create the Pages project (accept the suggested name
`sptts`). Wrangler prints the production URL, e.g. `https://sptts.pages.dev`.

## 5. Local preview of the production build

```bash
npm run deploy:preview
# serves client/dist + the real Pages Functions on http://localhost:8788
# (reads .dev.vars for DATABASE_URL — currently the local Postgres)
```

## How it works

- `functions/api/[[route]].js` routes every `/api/*` request into the Hono
  app in `functions/_app.js`, which reuses `server/src/store.js` verbatim —
  the Express server (`npm run dev:server`) and the Worker share one store
  layer and one schema.
- Every request creates a fresh `pg` pool and closes it after the response;
  Hyperdrive pools the actual database connections (node-postgres idle
  sockets break when reused across requests in the Workers runtime).
- Passwords use PBKDF2-SHA-256 (100k iterations) via Web Crypto
  (`server/src/auth-crypto.js`) — bcrypt deadlocks the Workers runtime. The
  Express login transparently rehashes legacy bcrypt hashes on successful
  login (`server/src/auth.js`).
- The client keeps calling relative `/api/...` — same origin, no CORS or
  base-URL changes needed.

## Updating

```bash
npm run deploy:pages   # rebuild + redeploy (always runs deploy:copy-lib first)
```

## Troubleshooting

- **"No database configured"** — no Hyperdrive binding and no
  `DATABASE_URL` secret; see step 3.
- **"Invalid email or password" on a migrated DB** — the password hashes are
  still bcrypt; run `node server/scripts/migrate-auth.js "<url>"` (resets
  passwords to the demo default) or log in once through the Express server
  (transparent rehash).
- **Login 500s on the free Workers plan** — bcrypt-era CPU limits; the
  PBKDF2 auth above avoids this. If you ever reintroduce bcrypt, upgrade the
  plan first.
