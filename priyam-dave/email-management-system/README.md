# Email Management System (EMS)

Node/Express service that runs the EchoSphere donor **email lifecycle** —
the Phase A `$1`-reservation ask sequence and the Phase B launch-week campaign.
It is co-located in this repo (like `mosaic-system/`) but runs as its **own
process** with its **own PostgreSQL database**. It does **not** share the app's
SQL Server.

## How it fits with the rest of the app

```
Contacts enter EMS ── CSV import (admin) ─┐
                   └─ POST /signup        ─┴─▶ EMS users (Postgres) ─▶ Phase A lifecycle
                                                (welcome $1-ask → nudge → final)

Reserve conversion (the $1):
  Landing form ─▶ Flask /reserve/checkout ─▶ Stripe Checkout
  Stripe ─checkout.session.completed─▶ Flask /reserve/stripe_webhook   (single Stripe endpoint)
        • updates reservation in SQL Server + fireflies counter
        • POST ─X-Internal-Service-Token─▶ EMS /internal/reserved
              → upsert user reserved+vip, exit Phase A,
                send reserved_thankyou (Gmail), enter Phase B
```

Key integration decisions:

- **Flask owns the single Stripe webhook.** EMS has **no** public Stripe
  webhook. Flask notifies EMS via the authenticated `POST /internal/reserved`
  after a payment (real or local mock) is confirmed.
- **EMS/Gmail owns all campaign email** — `reserved_thankyou`, the whole Phase A
  lifecycle, and Phase B. The Flask backend no longer sends its own
  confirmation email.
- **Every reserve CTA drives to the landing page.** Email `{{RESERVE_LINK}}`
  buttons route through EMS's `/reserve-click/:token` (which counts the click)
  and then redirect to `PUBLIC_APP_URL/emotion-sphere?ref=<token>`.

## Admin dashboard

EMS ships a self-contained admin dashboard so the lifecycle can be seen and
driven by hand — no separate build step. Once the server is running it lives at:

```
http://localhost:4000/admin
```

It is gated by the same Basic Auth as `/admin/*` (`ADMIN_USERNAME` /
`ADMIN_PASSWORD_HASH`); the browser prompts once. Four tabs:

- **Overview** — headline metrics (contacts, reserved, revenue, emails sent,
  open/click rate) and the Phase A reserve-ask funnel.
- **Contacts** — searchable, stage-filterable table; click a row for that
  contact's full email timeline (sends, opens, clicks, reservation).
- **Actions** — add a single signup, upload a CSV, or manually trigger a Phase B
  campaign email.
- **Emails** — preview any of the rendered MJML templates.

It is powered by read-only JSON endpoints under `/admin/api/*` (see Routes) plus
the existing action routes. The email lifecycle, scheduler, and mailer are
untouched.

### Seeing it with demo data

To populate a fresh database with lifecycle-spread sample contacts (so the
dashboard looks alive), run the seed after loading the schema:

```bash
npm run seed        # inserts ~40 demo contacts + email history (source='demo')
```

The seed is idempotent — it clears its own `source='demo'` rows before
re-inserting and never touches real contacts.

## Requirements

- Node.js LTS
- PostgreSQL
- A Gmail account with an App Password (SMTP sending)

## Setup

```bash
cd email-system
npm install
cp .env.example .env        # then fill in real values

# Load the schema into your Postgres database:
psql "$PG_CONNECTION_STRING" -f sql/schema.sql
psql "$PG_CONNECTION_STRING" -f sql/migration_v2.sql

npm start                   # starts the server + cron scheduler on PORT (default 4000)
```

The cron scheduler (every 10 min) drives Phase A and checks Phase B. Warmup caps
throttle daily Gmail volume (see `WARMUP_START_DATE` in `mailer.js`).

## Environment variables

| Variable | Purpose |
|----------|---------|
| `PG_CONNECTION_STRING` | Postgres connection string (EMS's own DB) |
| `GMAIL_USER` / `GMAIL_APP_PASSWORD` | Gmail SMTP sender + App Password |
| `WARMUP_START_DATE` | Day 1 of the sending warmup ramp |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD_HASH` | Basic-Auth gate for `/admin/*` (bcrypt hash) |
| `JWT_SECRET` | Signs open/click/unsubscribe tracking tokens |
| `PUBLIC_BASE_URL` | EMS's own base URL — tracking pixels + unsubscribe links point here |
| `PUBLIC_APP_URL` | Landing-page base URL — reserve CTAs drive to `…/emotion-sphere` |
| `INTERNAL_SERVICE_TOKEN` | Shared secret for `POST /internal/reserved`. **Must match the Flask backend's `INTERNAL_SERVICE_TOKEN`.** |
| `PORT` | Server port (default 4000; 3000 collides with the React dev server) |

> Stripe is intentionally **not** configured here — Flask owns the webhook.

## Routes

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `POST` | `/signup` | none | Add a contact to the Phase A funnel |
| `POST` | `/upload-csv` | none¹ | Bulk-import contacts from a CSV |
| `POST` | `/internal/reserved` | `X-Internal-Service-Token` | Flask → EMS reservation handoff (upsert reserved+vip, send thank-you) |
| `GET` | `/admin` | Basic Auth | Admin dashboard (static UI) |
| `GET` | `/admin/api/metrics` | Basic Auth | Headline metrics + Phase A funnel |
| `GET` | `/admin/api/contacts` | Basic Auth | Contacts list (filter: `q`, `stage`, `limit`) |
| `GET` | `/admin/api/contacts/:id` | Basic Auth | One contact + send/analytics timeline |
| `PATCH` | `/admin/api/contacts/:id` | Basic Auth | Update the contact's name used for email personalization |
| `DELETE` | `/admin/api/contacts/:id` | Basic Auth | Delete contact data and add its email to suppression |
| `GET` | `/admin/api/send-log` | Basic Auth | Recent sends across all contacts |
| `GET` | `/admin/api/suppression` | Basic Auth | Suppression list |
| `GET` | `/admin/api/templates` | Basic Auth | Template list |
| `POST` | `/admin/api/templates` | Basic Auth | Add a validated custom MJML template |
| `DELETE` | `/admin/api/templates/:name` | Basic Auth | Delete a custom MJML template; built-ins are protected |
| `GET` | `/admin/api/templates/:name` | Basic Auth | Rendered MJML preview (HTML) |
| `POST` | `/admin/campaign-email` | Basic Auth | Manually trigger a Phase B send |
| `POST` | `/admin/custom-email` | Basic Auth | Send a one-off email to an existing contact |
| `GET` | `/track/open/:token` | token | Open-tracking pixel |
| `GET` | `/track/click/:token` | token | Click tracking → redirect |
| `GET` | `/reserve-click/:token` | token | Reserve-intent click → redirect to landing `/emotion-sphere` |
| `GET` | `/unsubscribe` | token | Unsubscribe / suppression |
| `GET` | `/health` | none | Liveness check |

¹ `/signup` and `/upload-csv` are currently unauthenticated — put them behind the
admin gate or a network boundary before exposing EMS publicly.

## Database

Postgres tables (`sql/schema.sql` + `sql/migration_v2.sql`): `users` (contacts +
lifecycle state), `campaigns`, `send_log`, `analytics_events`,
`suppression_list`.

## Notes / follow-ups

- `stripe` remains listed in `package.json` but is unused after removing the
  webhook; safe to prune on the next dependency pass.
- Abandoned-checkout nurture (feeding not-yet-paid landing emails into Phase A)
  is intentionally out of scope for this integration.
