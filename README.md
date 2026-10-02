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
  collection timestamp is logged automatically. Also:
  - **Pickup-list check**: warns before releasing a child to someone not on
    their authorized-pickups list ("Father only" means Mother is flagged; with
    no "only", parents are always fine). Staff can still release after the
    warning, and it's recorded.
  - **Linked siblings**: collect brothers and sisters in one tap; they share one
    monthly statement.
  - **Same as yesterday**: Roll Call can start from the last aftercare day's
    list (Friday's, on a Monday); untick anyone who isn't here and check the
    rest in with one tap.
  - **Roll call filters**: sort A–Z or by most hours this month, and show one
    class at a time.
  - **Undo** after every collect and roll-call check-in.
  - **Late-pickup WhatsApp message** to the parent from 15 minutes before
    closing, marked "Messaged" so other staff can see it's been done.
  - **Admin** (second PIN): billing rates, monthly tally per child, attendance
    history, and **printable monthly family statements** (save as PDF).
  - **Parent View**: a private no-login link per child for parents.
  - Optional **daily log email** once everyone's been collected.
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

Mirrors the Shipments Tracker's setup on the same box (`8088` is Immich, `8089`
is the Shipments Tracker). `8090` turned out to already be taken by something
else on this box, so this app actually runs on **`8092`**. That Unraid install
doesn't have the `docker compose` plugin, so this uses plain `docker run` —
`docker-compose.yml` describes the same thing if you ever install the Compose
Manager plugin.

```bash
cd /mnt/user/appdata/           # or wherever you keep these
git clone https://github.com/cp6969/Howick-Pre-primary-Aftercare.git howick-aftercare
cd howick-aftercare

cp .env.example .env
# edit .env: fill in APP_USERNAME, APP_PASSWORD_HASH, ADMIN_PIN_HASH, SESSION_SECRET
# (leave TUNNEL_TOKEN blank -- not needed for LAN-only)

docker build -t howick-aftercare:latest .

docker run -d --name howick-aftercare-tracker \
  --env-file .env -v "$(pwd)/data:/app/data" -p 8092:3000 \
  --restart unless-stopped howick-aftercare:latest
```

Visit `http://<unraid-ip>:8092`, log in, and use **Manage children** to load
the roster.

### Public URL

Live at **https://hpps.burgtec.co.za**, via the optional `cloudflared` service
in `docker-compose.yml` (a tunnel created in the Cloudflare Zero Trust
dashboard, its token in `.env` as `TUNNEL_TOKEN`, with a published application
route pointing at `app:3000`). LAN access on port `8092` still works as a
fallback if the tunnel is down.

If the school later gets its own domain onto Cloudflare, this can move to a
subdomain of `howickpreprimary.co.za` (e.g. `aftercare.howickpreprimary.co.za`)
by swapping the route in the same tunnel — no app changes needed.

## Data model

- **children** — the school roster (name, group, parent/guardian, phone,
  free-text authorized pickups). Archiving a child (instead of deleting) keeps
  their attendance history intact.
- **attendance** — one row per child per day they actually came to aftercare.
  `checked_in_at` is always 13:00 SAST on that date; `collected_at` /
  `collected_by` are filled in when they're picked up. A child who didn't attend
  a given day simply has no row — there's nothing to mark absent.
- **settings** — collection cutoff time, hourly rate, daily minimum hours, late
  fee per 15 minutes, currency (edited on the Admin page), plus the daily-email
  settings.

New columns are added automatically on start-up, so updating is just `git pull`,
`docker build`, and recreating the container; the database in `data/` is kept.

Live and running on the school's Unraid box at https://hpps.burgtec.co.za.
