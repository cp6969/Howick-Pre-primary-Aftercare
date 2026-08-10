# Howick Pre-Primary — Aftercare Tracker

A working aftercare sign-in/sign-out tracker for Howick Pre-Primary & Baby Centre,
styled to the school's actual site branding (colors, Jost/Open Sans typefaces, logo
palette).

Picking this up fresh (new session, new machine, handing off to someone else)?
Read [`HANDOVER.md`](HANDOVER.md) first — it has the full history, the
decisions already made, and what's still outstanding.

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

### Deploying on Unraid (LAN-only)

Mirrors the Shipments Tracker's setup on the same box, on port `8090` (`8088` is
Immich, `8089` is the Shipments Tracker). That Unraid install doesn't have the
`docker compose` plugin, so this uses plain `docker run` — `docker-compose.yml`
describes the same thing if you ever install the Compose Manager plugin.

```bash
cd /mnt/user/appdata/           # or wherever you keep these
git clone https://github.com/cp6969/Howick-Pre-primary-Aftercare.git howick-aftercare
cd howick-aftercare

cp .env.example .env
# edit .env: fill in APP_USERNAME, APP_PASSWORD_HASH, SESSION_SECRET
# (leave TUNNEL_TOKEN blank -- not needed for LAN-only)

docker build -t howick-aftercare:latest .

docker run -d --name howick-aftercare-tracker \
  --env-file .env -v "$(pwd)/data:/app/data" -p 8090:3000 \
  --restart unless-stopped howick-aftercare:latest
```

Visit `http://<unraid-ip>:8090`, log in, and use **Manage children** to load
the roster.

### Going public later

When you're ready for a real URL, the plan is a subdomain of
`howickpreprimary.co.za` (e.g. `aftercare.howickpreprimary.co.za`) — that only
works once that domain's DNS is managed in Cloudflare (either you or the school
would need access to set that up, the same way `13industries.co.za` was moved
to Cloudflare for the Shipments Tracker). Once that's sorted, `docker-compose.yml`
already has an optional `cloudflared` service ready to go — create a tunnel in
the Cloudflare Zero Trust dashboard, put its token in `.env` as `TUNNEL_TOKEN`,
and add a published application route pointing at `app:3000`.

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
