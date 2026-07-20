# LEDGORA production deployment (Render)

Two services: a **static frontend** and a **Node API**. The authentication
transport is the part that must be right, because the session lives in a cookie
and a cookie only travels if its `SameSite`/`Secure` attributes match how the
browser reaches the API.

There are two supported topologies. **Pick one.**

---

## Option A — same-origin `/api` proxy (recommended)

The browser only ever talks to the **frontend** origin. The frontend static site
reverse-proxies `/api/*` to the API. The cookie is therefore a genuine
same-origin cookie: `HttpOnly`, `Secure`, `SameSite=Lax`. No cross-site cookie,
no CORS on the browser's critical path, nothing readable by JavaScript.

### Frontend service (static site)
| Setting | Value |
| --- | --- |
| Build command | `npm ci && npm run build` |
| Publish directory | `dist` |
| Rewrite (first) | `/api/*` → `https://<YOUR-API-HOST>.onrender.com/api/*` **(type: Rewrite)** |
| Rewrite (second) | `/*` → `/index.html` **(type: Rewrite)** — SPA fallback |
| Env `VITE_API_URL` | `https://<YOUR-FRONTEND-HOST>.onrender.com` (this site's own origin) |
| Env `VITE_LEDGORA_DEV_TOOLS` | `false` |

The `/api/*` rule **must be listed above** the `/*` SPA fallback, or every API
call returns `index.html`.

### API service (web service, `rootDir: server`)
| Env | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `TRUST_PROXY` | `true` |
| `FRONTEND_URL` | `https://<YOUR-FRONTEND-HOST>.onrender.com` |
| `COOKIE_SAMESITE` | `lax` |
| `COOKIE_PARTITIONED` | `false` |
| `DATABASE_URL` | the PostgreSQL internal connection string |
| `SESSION_SECRET` | a fresh 32-byte random value (see below) |

`render.yaml` at the repo root encodes exactly this. Update the two hostnames in
it and deploy as a Blueprint, or apply the tables above by hand.

---

## Option B — cross-site (browser talks to the API host directly)

Only if you cannot put a proxy in front of the API. The cookie must be
`SameSite=None; Secure`, and — because a `SameSite=None` cookie cannot be read
cross-site — the CSRF token is delivered in the login/session **response body**
and kept in memory, never read from `document.cookie`.

### Frontend
| Env | Value |
| --- | --- |
| `VITE_API_URL` | `https://<YOUR-API-HOST>.onrender.com` (the API origin) |

Remove the `/api/*` rewrite (keep the `/*` → `/index.html` SPA fallback).

### API
| Env | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `TRUST_PROXY` | `true` |
| `FRONTEND_URL` | `https://<YOUR-FRONTEND-HOST>.onrender.com` |
| `COOKIE_SAMESITE` | `none` |
| `COOKIE_PARTITIONED` | `true` (recommended; CHIPS, where the browser supports it) |
| `DATABASE_URL`, `SESSION_SECRET` | as above |

The API refuses to boot in production with `COOKIE_SAMESITE=none` unless
`TRUST_PROXY=true`, so a misconfiguration fails loudly at deploy time instead of
silently dropping every cookie.

---

## SESSION_SECRET

Generate once, paste into the API service's environment, never commit:

```
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Rotating it invalidates outstanding CSRF tokens (users re-authenticate); session
rows in the database are unaffected.

## First administrator

No default admin exists. After the API is up with a real database:

```
# with a terminal:
npm run create-platform-admin -- --email you@example.com

# or, for the very first Render deploy (no shell): set BOOTSTRAP_ADMIN_* once,
# deploy, sign in, change the password, then remove BOOTSTRAP_ADMIN_PASSWORD and
# set BOOTSTRAP_ADMIN_ENABLED=false.
```

A bootstrap admin is forced through `/account/change-password` before the
console opens.

## Verifying the fix

1. Sign in as the super_admin on the frontend origin.
2. `POST /api/auth/login` sets the cookie; the **following** `GET
   /api/auth/session` returns `authenticated:true` with
   `platformRoles: ["super_admin"]`.
3. You land on `/admin/console`, not `/onboarding/organization`.
4. Hard-refresh `/admin/console` — it waits for verification, then stays.
5. In DevTools → Application → Cookies, `ledgora_session` is `HttpOnly` and
   (Option A) `SameSite=Lax` / (Option B) `SameSite=None; Secure`.
