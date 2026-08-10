# Howick Aftercare Tracker — Handover

Written so a fresh Claude Code session (or a human) can pick this up with zero
prior context. Read this before touching anything.

## 1. What this is

An aftercare sign-in/sign-out tracker built for Howick Pre-Primary & Baby
Centre (the user's wife's school). Started as a static design mockup, is now a
real working app: Node/Express + SQLite, styled to the school's actual site
branding (scraped from howickpreprimary.co.za via Firecrawl — colors, Jost/Open
Sans fonts embedded as base64 `@font-face`, logo palette).

Lives in its own repo, `cp6969/Howick-Pre-primary-Aftercare` (GitHub renamed it
lowercase — both `.../Howick-Pre-primary-Aftercare` and
`.../howick-pre-primary-aftercare` resolve the same place). This used to live
inside the `13-Industries` repo (an unrelated shipments-tracker app owned by
the same user) — it was moved out into its own repo partway through, so if you
ever see references to `13-Industries` in old conversation history, that's why.

## 2. Status right now

- **App is fully built and tested** (login, roll call, collect, CSV export —
  exercised both via curl and a real headless-browser Playwright pass) and
  pushed to `main`. Latest commit at time of writing: `16f6bf1`.
- **Not yet deployed anywhere.** The user asked to deploy to their Unraid box;
  this session has no SSH/remote access to that hardware, so instead I fixed a
  real port collision (see §6), generated deployment secrets, and handed the
  user a copy-paste runbook in chat (also in `README.md`). **Unconfirmed
  whether they've actually run it yet** — that's the natural next thing to
  check in on if picking this up.
- Decided explicitly: **LAN-only for now** (`http://<unraid-ip>:8090`). Public
  URL is planned for later on a `howickpreprimary.co.za` subdomain, but that's
  blocked on confirming someone (the user or the school) actually manages that
  domain's DNS in Cloudflare — not yet confirmed.

## 3. Key decisions already made (don't re-litigate without reason)

Asked the user explicitly, answers below — these shaped the whole build:

- **Stack**: same pattern as the user's other self-hosted app (`13-Industries`
  Shipments Tracker) — Node/Express, `better-sqlite3`, `express-session` with a
  SQLite-backed store, Docker + `docker-compose.yml`. Chosen over a hosted
  platform specifically for consistency with infrastructure the user already
  runs.
- **Daily roster model**: not every child attends aftercare every day. Chosen
  approach — **no recurring schedule, no pre-registration**. A teacher does a
  **Roll Call** each afternoon and taps every child who's actually there today.
  Absence is simply the lack of a database row for that child on that date —
  there's nothing to reconcile or mark absent.
- **Arrival time**: every aftercare child starts at 13:00, always. So arrival
  is never manually entered — `checked_in_at` is auto-stamped 13:00 SAST the
  moment a child is rolled-called in. Only collection time varies per child.
- **Collection flow**: originally a free-text "collected by" field. The user
  refined this mid-build to a faster tap flow: **Mother / Father / Other**
  buttons (Other reveals a text field, pre-suggested from that child's saved
  pickup notes). This is what shipped — see `#who-grid` / `.who-btn` in
  `public/index.html`.
- **Auth**: one shared username/password for all aftercare staff (not
  per-person logins) — deliberately simple, matches the shared-login pattern
  already used by the Shipments Tracker (`requireSiteAuth` in `server.js`).
- **Terminology**: the check-in button is labeled **"Roll call"**, not "New
  check-in" — renamed mid-build at the user's request to match how they
  actually think about the workflow.

## 4. Project structure

```
server.js          -- Express app, shared-login session gate (mirrors
                       13-Industries' pattern, minus the Google OAuth bits --
                       this app doesn't need Drive/Gmail integration)
api.js              -- all /api/* routes (children, attendance, stats, settings,
                       CSV export)
db.js               -- SQLite schema + SAST (Africa/Johannesburg, UTC+2,
                       no-DST) date helpers -- deliberately not relying on the
                       server's local timezone, since a Docker container
                       usually defaults to UTC
session-store.js    -- better-sqlite3-backed express-session store, copied
                       verbatim from 13-Industries (no changes needed)
public/index.html   -- the whole live app: dashboard, roll call modal, collect
                       modal, manage-children admin panel. Vanilla JS, no
                       framework, single <script> block -- same convention as
                       13-Industries' public/index.html
public/login.html   -- login page, restyled to Howick branding
public/fonts.css    -- Jost + Open Sans embedded as base64 @font-face (~330KB),
                       shared by both HTML pages via <link>
mockup.html         -- the original static design concept. Kept for reference,
                       not used by the running app.
Howick-Aftercare-Billing.xlsx
                    -- companion billing workbook (Rates & Settings -> Daily
                       Log -> Billing Summary -> per-child Invoice). The app's
                       CSV export (/api/attendance/export.csv) is formatted to
                       paste straight into its Daily Log tab.
Dockerfile, docker-compose.yml, .env.example, .gitignore
                    -- deployment scaffolding, same shape as 13-Industries
```

## 5. Data model

- **`children`** — the school roster: `full_name`, `group_name`, `parent_name`,
  `parent_phone`, `pickup_notes` (free text, comma-separated authorized
  pickups), `active` (soft-delete flag — archiving instead of deleting keeps
  attendance history intact).
- **`attendance`** — one row per child per day they actually attended.
  `checked_in_at` always = 13:00 SAST on `date` (see §3). `collected_at` /
  `collected_by` filled in on collection. `UNIQUE(child_id, date)` — Roll Call
  is idempotent, tapping an already-checked-in child again just returns the
  existing row.
- **`settings`** — key/value: `cutoff_time` (17:30 default, drives the "late
  collection" flag), `hourly_rate`, `late_fee_per_block`, `currency`. Read by
  the API for stats; **not yet exposed in the UI** — would need a settings
  screen if the user wants to change these without editing the DB directly.

## 6. Real bugs hit and fixed during development

Worth knowing so they don't get reintroduced:

1. **`db.js` wouldn't even boot** — a SQL comment inside the schema's
   template-literal string contained a raw `` `date` `` (backticks-as-code-
   formatting habit), which closed the JS template literal early and broke the
   file. Fixed by rewording the comment to not use backticks. Lesson: never put
   backticks inside a JS template literal, even in a SQL comment.
2. **The "Cancel edit" button in Manage Children stayed visible when it
   shouldn't have.** Cause: `.btn { display: inline-flex }` beats the
   browser's built-in `[hidden] { display: none }` rule at equal CSS
   specificity, because author styles rank above the UA stylesheet regardless
   of specificity ties. Fixed with an explicit `[hidden] { display: none
   !important; }` near the top of both `public/index.html` and
   `public/login.html`. **If you ever add a new element that toggles via the
   `hidden` attribute, make sure it doesn't have its own explicit `display`
   override fighting this** — the global rule should cover it, but worth
   knowing why it's there.
3. **Port collision caught before deployment, not after**: `docker-compose.yml`
   originally guessed port 8089 was free on the Unraid box. The Shipments
   Tracker's own handover doc (`13-Industries/Shipments-Tracker-Handover.md`)
   says 8089 is *already* that app's port (8088 is Immich) — moved this app to
   **8090** instead. If deploying a third app to the same box later, check
   what's actually running (`docker ps`) rather than guessing again.

## 7. Deploying (LAN-only, not yet confirmed run)

Exact commands are in `README.md`. Summary: `git clone` onto the Unraid box
(`/mnt/user/appdata/howick-aftercare` suggested), `cp .env.example .env`, fill
in `APP_USERNAME` / `APP_PASSWORD_HASH` / `SESSION_SECRET`, `docker build`,
then a plain `docker run` (that Unraid install doesn't have the `docker
compose` plugin, per the Shipments Tracker precedent — `docker-compose.yml`
describes the same setup for if that ever changes).

**Real secrets were generated and given to the user directly in chat, not
committed anywhere** (consistent with `.env` being gitignored and never
containing real values in the repo). If you need to regenerate them:

```bash
node -e "console.log(require('crypto').randomBytes(9).toString('base64').replace(/[^a-zA-Z0-9]/g,'').slice(0,12))"   # a password
node -e "console.log(require('bcryptjs').hashSync('paste-the-password-here', 10))"                                    # its hash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"                                              # SESSION_SECRET
```

## 8. Outstanding / next steps

- **Confirm the Unraid deployment actually happened and works** — visit
  `http://<unraid-ip>:8090`, log in, run through Roll Call → Collect once for
  real. This is the most likely next ask.
- **Public URL**: blocked on confirming Cloudflare DNS access to
  `howickpreprimary.co.za`. Once that's sorted, `docker-compose.yml` already
  has an optional `cloudflared` service ready — create a tunnel, put its token
  in `.env` as `TUNNEL_TOKEN`, add a published route to `app:3000`. This is a
  separate, independent tunnel from the Shipments Tracker's — nothing shared,
  nothing at risk of breaking that app.
- **Settings UI**: `cutoff_time` / `hourly_rate` / `late_fee_per_block` /
  `currency` exist in the database and are read by the stats/CSV endpoints,
  but there's no screen to edit them yet — currently would need a direct DB
  edit or a quick `PUT /api/settings` call.
- **Loading the real roster**: the app has "Manage children" with both
  one-at-a-time add and a bulk-paste box (one child per line, `"Name, Group"`)
  — nobody has loaded Howick's actual class list in yet, it's still empty in
  production. That's the first thing the user (or a teacher) needs to do once
  deployed.
- Nothing else known-broken. The two bugs in §6 are fixed and verified, not
  just patched-and-hoped.
