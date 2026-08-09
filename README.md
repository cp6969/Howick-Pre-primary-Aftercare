# Howick Pre-Primary — Aftercare Tracker

A working aftercare sign-in/sign-out tracker for Howick Pre-Primary & Baby Centre,
styled to the school's actual site branding (colors, Jost/Open Sans typefaces, logo
palette).

## What's here

- **The app** (`server.js`, `api.js`, `db.js`, `public/`) — a small self-hosted
  Node.js/Express app with a SQLite database. Not every child attends aftercare
  every day, so there's no pre-registered roster to reconcile — a teacher does a
  **Roll Call** each afternoon (tap a child's name to add them to today's list;
  arrival is always stamped 13:00, since that's when aftercare starts), then taps
  **Collect** as each child leaves and picks **Mother / Father / Other**. The
  collection timestamp is logged automatically.
- **`mockup.html`** — the original static design concept, kept for reference.
- **`Howick-Aftercare-Billing.xlsx`** — companion billing workbook (Rates & Settings
  → Daily Log → Billing Summary → per-child Invoice). The app's CSV export
  (`Export today's log`, or `/api/attendance/export.csv?from=...&to=...` for a date
  range) pastes straight into the Daily Log tab.

## Running it

```bash
npm install
cp .env.example .env
```

Edit `.env`:
- `APP_USERNAME` / `APP_PASSWORD_HASH` — the one shared login all aftercare staff
  use. Generate the hash with:
  ```bash
  node -e "console.log(require('bcryptjs').hashSync('your-password', 10))"
  ```
- `SESSION_SECRET` — a random string:
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```

Then:
```bash
npm start
```

Open `http://localhost:3000`, log in, and use **Manage children** to load the
school roster (one at a time, or paste a whole list at once with **Bulk add**).

### Deploying

`Dockerfile` + `docker-compose.yml` are set up the same way as the `13-Industries`
Shipments Tracker repo — `docker compose up -d` builds and runs it, with the
SQLite database persisted to `./data`. Put a reverse proxy (Cloudflare Tunnel,
nginx, etc.) in front of it for a real URL; see the Shipments Tracker repo's
compose file for a worked Cloudflare Tunnel example.

## Data model

- **children** — the school roster (name, group, parent/guardian, phone,
  free-text authorized pickups). Archiving a child (instead of deleting) keeps
  their attendance history intact.
- **attendance** — one row per child per day they actually came to aftercare.
  `checked_in_at` is always 13:00 SAST on that date; `collected_at` /
  `collected_by` are filled in when they're picked up. A child who didn't attend
  a given day simply has no row — there's nothing to mark absent.
- **settings** — collection cutoff time, hourly rate, late fee, currency. Read by
  the API for the "late collection" flag and available for a future billing
  calculator; not yet exposed in the UI.

Not a live system in the sense of being deployed anywhere yet — but it's a real
app with a real database, ready to run.
