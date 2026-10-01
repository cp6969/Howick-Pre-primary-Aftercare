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

- **Live and in use** on the school's Unraid box: LAN at
  `http://<unraid-ip>:8092`, public at **https://hpps.burgtec.co.za** via a
  Cloudflare Tunnel (the `cloudflared` service in `docker-compose.yml`).
  `8090` turned out to be taken on that box, so `8092` is the real port --
  ignore any older mention of 8090.
- Merged to `main` via PRs #1-#6: Admin area (PIN-gated), daily-log email,
  live cost tally, school logo, Parent View, header wordmark.
- **Branch `claude/pickup-safety-siblings-statements`** adds the "missing
  features" round (see §7): pickup-list check, linked siblings, undo, late
  pickup WhatsApp message, monthly family statements, plus four layout fixes.
  Not merged yet -- check whether it has a PR. After merging, the Unraid box
  needs `git pull` + `docker build` + recreate the container to pick it up
  (the DB migrates itself on start; see §5).
- **Visual redesign is parked.** Four directions were mocked up (A Studio,
  B Playground, C Pickup Board, D Pocket) in a claude.ai artifact; the user
  said "we'll come back to the design". Don't start one without asking which.

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
server.js          -- Express app: shared-login session gate, admin PIN gate
                       (requireAdminAuth / requireAdminAuthApi), Parent View
                       routes (/parent/:token, no login)
api.js              -- staff /api/* routes: children (incl. siblings), roll
                       call, collect (with pickup check), undo, nudge, stats,
                       CSV export, daily-log email settings
admin.js            -- /api/admin/* (PIN-gated): billing rates, monthly tally,
                       per-child history, family statements
reports.js          -- shared queries + billing maths (costForRow, monthly
                       tally, CSV, familyStatements)
pickup.js           -- checkPickup(): is this person on the child's pickup list?
db.js               -- SQLite schema, migrations (addColumnIfMissing), demo
                       seed, SAST (UTC+2, no DST) date helpers
mailer.js, scheduler.js
                    -- optional automatic "today's log" email (nodemailer)
session-store.js    -- better-sqlite3-backed express-session store
public/index.html   -- tracker: stats, awaiting pickup, roster, roll call,
                       collect modal. Vanilla JS, single <script> block
public/settings.html-- manage children (siblings, parent links), daily email
public/admin.html   -- rates, monthly tally, history, statement links
public/statement.html
                    -- printable A4 family statements (admin-gated)
public/parent.html  -- Parent View
public/theme.css, fonts.css, group-colors.js, logo.png -- shared styling
mockup.html         -- original static design concept, not used by the app
Howick-Aftercare-Billing.xlsx
                    -- companion billing workbook; the CSV export pastes
                       straight into its Daily Log tab
Dockerfile, docker-compose.yml, .env.example, .gitignore
```

## 5. Data model

- **`children`** -- the roster: `full_name`, `group_name`, `parent_name`,
  `parent_phone`, `pickup_notes` (free text, comma-separated authorized
  pickups), `active` (soft-delete; archiving keeps history), `parent_token`
  (the secret in a Parent View link), `family_id` (siblings share one value,
  the lowest child id in the family; NULL = no linked siblings).
- **`attendance`** -- one row per child per day they actually attended.
  `checked_in_at` always = 13:00 SAST on `date` (see §3). `collected_at` /
  `collected_by` filled in on collection. `off_list` = 1 when staff released
  the child to someone not on the pickup list after the warning (audit trail,
  shown in the roster, history and CSV). `nudged_at` = when staff last opened
  the late-pickup WhatsApp message. `UNIQUE(child_id, date)`, so Roll Call is
  idempotent.
- **`settings`** -- key/value: `cutoff_time` (17:30), `hourly_rate`,
  `daily_minimum_hours`, `late_fee_per_block` (per 15 min or part past the
  cutoff), `currency`, plus the daily-log email settings. Rates are edited on
  the Admin page.

Columns added after launch go through `addColumnIfMissing()` in `db.js`, which
runs on every start, so a deployed database upgrades itself. Use that for any
new column -- never edit the `CREATE TABLE` alone.

## 6. Features added after launch (branch `claude/pickup-safety-siblings-statements`)

- **Pickup-list check** (`pickup.js`). When Collect is tapped, the person is
  checked against the child's `pickup_notes`:
  - Empty notes = no list on file, never flagged.
  - Any entry containing "only" makes the list strict ("Father only" means
    Mother *is* flagged).
  - Otherwise parents are always allowed (Mother, Father, or `parent_name`),
    plus everyone listed.
  - "Grandmother (Nomsa)" matches "Grandmother", "Nomsa" or the whole entry.
  - Not on the list: `POST /api/attendance/:id/collect` returns **409**
    `code: 'not_on_pickup_list'`; the modal shows a warning and staff can go
    back or "Release anyway", which resends with `override: true` and stores
    `off_list = 1`. It's a warning, not a hard block, on purpose -- staff know
    the families.
- **Linked siblings**. Set in Settings -> child -> "Siblings at the school"
  (`sibling_ids` on `POST/PUT /api/children`; replaces the whole set, adding a
  child who already has siblings brings their family along). Collecting one
  child offers to collect their checked-in siblings in the same tap
  (`also_attendance_ids`); each sibling is checked against *their own* pickup
  list. Siblings share one statement.
- **Undo**. Collect and roll-call check-in both show a toast with Undo for
  6 s (uncollect / delete the attendance row).
- **Late-pickup WhatsApp message**. Rows in "Awaiting pickup" get a Message
  link from 15 min before the cutoff: a `wa.me` link to the parent's phone
  (SA `0xx` -> `27xx`) with a polite pre-filled message. It deliberately makes
  no fee claim. The Parent View link is only included when the page is opened
  on a public hostname (on a LAN IP it would be useless to the parent).
  Opening it calls `POST /api/attendance/:id/nudge`, so other staff see
  "Messaged HH:MM".
- **Monthly family statements**. `GET /api/admin/statements?month=YYYY-MM
  [&family=f12|c7]` -> `reports.familyStatements()`. Rendered by
  `/statement.html` (admin-gated): one A4 sheet per family with a per-day
  table per child and the amount due; "Print or save as PDF" uses the
  browser's print. Admin -> "Print all statements", or the per-child
  "Statement" link. Family key = `f<family_id>` for linked siblings, else
  `c<child id>`.
- **Layout fixes**: Collect button no longer overlaps long names; roster no
  longer clips its last column (the always-13:00 Arrival column was dropped);
  on phones "Awaiting pickup" now sits above the roster; Settings rows have
  Edit plus a "..." menu instead of four links.

## 7. Real bugs hit and fixed during development

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
3. **Port collision, twice**: `docker-compose.yml` originally guessed port 8089
   was free on the Unraid box. The Shipments Tracker's own handover doc
   (`13-Industries/Shipments-Tracker-Handover.md`) says 8089 is *already* that
   app's port (8088 is Immich) — moved this app to 8090. That also turned out
   to be taken by something else on the box, so it moved again to **8092**,
   which is what's actually deployed. If deploying a third app to the same box
   later, check what's actually running (`docker ps`) rather than guessing.

## 8. Deploying

Exact commands are in `README.md`. Summary: the repo is cloned on the Unraid
box (`/mnt/user/appdata/howick-aftercare` suggested), `.env` holds
`APP_USERNAME` / `APP_PASSWORD_HASH` / `ADMIN_PIN_HASH` / `SESSION_SECRET`
(+ optional `TUNNEL_TOKEN`, `SMTP_*`), `docker build`, then a plain
`docker run` on port 8092 (that Unraid install has no `docker compose`
plugin). To update: `git pull`, `docker build`, `docker rm -f` the container
and `docker run` again -- the `data/` volume keeps the database.

**Real secrets were generated and given to the user directly in chat, not
committed anywhere** (consistent with `.env` being gitignored and never
containing real values in the repo). If you need to regenerate them:

```bash
node -e "console.log(require('crypto').randomBytes(9).toString('base64').replace(/[^a-zA-Z0-9]/g,'').slice(0,12))"   # a password
node -e "console.log(require('bcryptjs').hashSync('paste-the-password-here', 10))"                                    # its hash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"                                              # SESSION_SECRET
```

## 9. Outstanding / next steps

- Merge the features branch (§6) and redeploy on Unraid.
- **Pick a design direction** (parked, see §2).
- Feature ideas offered but not built yet: "same as yesterday" roll call,
  find-a-child search on the tracker, per-day notes / allergy flags on the
  roster, installable PWA (home-screen icon), kiosk mode for a wall tablet.
- Public URL on a `howickpreprimary.co.za` subdomain: only if the school gets
  that domain onto Cloudflare; swap the route in the same tunnel, no app
  changes.
