# Renewal Risk Detection System

Identifies residents at risk of not renewing their leases and delivers renewal events to an external Revenue Management System (RMS) via signed webhooks with guaranteed delivery.

---

## Prerequisites

| Tool | Version |
|------|---------|
| Node.js | 18 + |
| PostgreSQL | 16 (via Docker **or** local install) |
| Docker + Compose | any recent version (optional) |

---

## Quick Start

### 1. Database

**Option A — Docker (recommended)**
```bash
docker-compose up -d
# PostgreSQL starts on port 5433 to avoid conflicts with a local install.
```

Then set `DATABASE_URL` in `backend/.env`:
```
DATABASE_URL=postgres://postgres:postgres@localhost:5433/renewal_risk
```

**Option B — local PostgreSQL**

Create the database, then use the default port 5432 (already in `backend/.env`):
```bash
createdb renewal_risk
```

### 2. Apply the schema migration

```bash
cd backend
cp .env.example .env        # edit DATABASE_URL if needed
psql $DATABASE_URL -f migrations/001_init.sql
```

### 3. Seed sample data + start the backend

```bash
npm install
npm run seed     # inserts 15 residents with varied risk profiles; prints PROPERTY_ID
npm run dev      # → http://localhost:3000  (hot reload)
```

The seed script prints the **Property ID** you'll use for all subsequent commands.

### 4. Start the frontend

```bash
cd ../frontend
npm install
npm run dev      # → http://localhost:5173
```

Open `http://localhost:5173`, paste the Property ID from the seed output, and click **View Dashboard →**.

---

## Manual API Testing

Replace `{PROPERTY_ID}` with the UUID printed by `npm run seed`.

### Calculate renewal risk scores

```bash
curl -s -X POST http://localhost:3000/api/v1/properties/{PROPERTY_ID}/renewal-risk/calculate \
  -H "Content-Type: application/json" \
  -d '{"asOfDate":"2026-03-19"}'
```

Expected: `totalResidents=15`, `flaggedCount=8` (4 high, 4 medium).

### Retrieve latest scores (no recalculation)

```bash
curl -s http://localhost:3000/api/v1/properties/{PROPERTY_ID}/renewal-risk
```

### Trigger a renewal event for a resident

```bash
# Replace {RESIDENT_ID} with any residentId from the scores response.
curl -s -X POST \
  http://localhost:3000/api/v1/properties/{PROPERTY_ID}/residents/{RESIDENT_ID}/renewal-event \
  -H "Content-Type: application/json"
```

Returns HTTP 202 with `{ eventId, webhookId, status: "pending" }`.

### Health check

```bash
curl http://localhost:3000/health
# → {"status":"ok"}
```

---

## Testing Webhook Delivery

### Option A — webhook.site (no setup, recommended for evaluators)

1. Go to **https://webhook.site** and copy your unique URL.
2. Update `RMS_ENDPOINT` in `backend/.env`:
   ```
   RMS_ENDPOINT=https://webhook.site/your-unique-path
   ```
3. Restart the backend (`Ctrl-C`, then `npm run dev`).
4. Trigger a renewal event (via the dashboard button or the curl command above).
5. The webhook appears on webhook.site within ~1 second.

The request will include:
- `Content-Type: application/json`
- `X-Event-Id: evt-{residentId}-{date}` — idempotency key
- `X-Webhook-Signature: sha256=<hex>` — HMAC-SHA256 of the body

### Option B — local mock RMS

```bash
# Terminal 1: mock RMS that always returns 200
node -e "
const http = require('http');
http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    console.log('Received:', JSON.parse(body).event, JSON.parse(body).eventId);
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok' }));
  });
}).listen(3001, () => console.log('Mock RMS on :3001'));
"

# Terminal 2: start the backend (RMS_ENDPOINT defaults to http://localhost:3001/webhook)
cd backend && npm run dev
```

### Verifying retry / DLQ behaviour

Leave the mock RMS stopped. Trigger an event and query the DB:

```sql
SELECT event_id, status, attempt_count, next_retry_at, rms_response
FROM webhook_delivery_state
ORDER BY created_at DESC LIMIT 5;
```

You should see `attempt_count` increment (1 → 2 → … → 5) with exponential delays (1 s, 2 s, 4 s, 8 s, 16 s), then `status = 'dlq'`.

```sql
SELECT wds.event_id, dlq.reason
FROM webhook_dead_letter_queue dlq
JOIN webhook_delivery_state wds ON wds.id = dlq.webhook_delivery_state_id;
```

### Verifying idempotency

Clicking "Trigger Event" twice on the same day returns the **same** `eventId` and `webhookId` — the second request hits the `ON CONFLICT (event_id) DO UPDATE` clause and returns the existing record without creating a duplicate delivery.

---

## Project Structure

```
.
├── backend/
│   ├── migrations/
│   │   └── 001_init.sql          # SQL migration (sole deliverable schema)
│   ├── scripts/
│   │   └── seed.ts               # 15-resident seed script
│   ├── src/
│   │   ├── api/
│   │   │   ├── middleware/       # asyncHandler, errorHandler, notFound
│   │   │   └── routes/           # renewalRisk.ts, renewalEvents.ts
│   │   ├── db/index.ts           # pg.Pool singleton + checkConnection
│   │   ├── services/
│   │   │   ├── riskScoringService.ts   # pure scoring function (no I/O)
│   │   │   └── renewalRiskService.ts   # DB orchestration
│   │   ├── webhooks/
│   │   │   ├── webhookService.ts       # sign, deliver, create+queue
│   │   │   └── retryWorker.ts          # background polling loop
│   │   ├── app.ts                # Express factory
│   │   ├── errors.ts             # AppError class
│   │   └── index.ts              # entry point + graceful shutdown
│   ├── .env.example
│   └── README.md                 # schema decisions, API contract, edge cases
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   │   └── RiskTable.tsx     # table with expandable signals + event button
│   │   ├── pages/
│   │   │   ├── LandingPage.tsx   # property ID input
│   │   │   └── RenewalRiskPage.tsx
│   │   ├── api.ts                # fetch helpers
│   │   ├── types.ts              # shared TypeScript interfaces
│   │   └── App.tsx               # React Router setup
│   └── README.md
├── docker-compose.yml
└── README.md                     # ← you are here
```

---

## Scoring Formula

Four signals, weights sum to 100 (no normalisation needed):

| Signal | Max pts | Scoring |
|---|---|---|
| Days to expiry | 40 | ≤30d → 40 · 31–60d → 30 · 61–90d → 20 · 91–120d → 10 · >120d → 0 · MTM → 20 (fixed) |
| Payment delinquency | 25 | 3+ missed → 25 · 2 missed → 15 · 1 missed → 5 · 0 missed → 0 |
| No renewal offer | 20 | No offer → 20 · Has offer → 0 |
| Rent vs market | 15 | >10% above market → 15 · 5–10% → 8 · ≤5% or no data → 0 |

**Tier thresholds:** `high ≥ 65` · `medium 40–64` · `low < 40`

**Seed scenario verification:**

| Resident | Calc | Score | Tier |
|---|---|---|---|
| Carol Martinez | 40+25+20+15 | 100 | high |
| Henry Anderson | 40+25+20+0  | 85  | high |
| David Lee      | 40+0+20+15  | 75  | high |
| Jane Doe       | 30+0+20+15  | 65  | high |
| John Smith     | 30+5+20+8   | 63  | medium |
| Bob Williams   | 20+0+20+15  | 55  | medium (MTM) |
| Emma Wilson    | 30+0+20+0   | 50  | medium |
| Frank Brown    | 40+5+0+0    | 45  | medium |
| Alice Johnson  | 0+0+0+0     | 0   | low |

---

## Design Decisions

See `backend/README.md` for detailed schema decisions, API contract, webhook signing verification, and full edge-case handling table.

**Key choices at a glance:**

- **Raw SQL over ORM** — queries are explicit, reviewable, and avoid N+1 problems by design (single CTE join fetches all signals in one round-trip).
- **Append-only score history** — `renewal_risk_scores` never overwrites; the dashboard always reads the latest row per resident via `DISTINCT ON`.
- **`pg_advisory_xact_lock`** — prevents simultaneous batch runs for the same property without a separate lock table.
- **Webhook payload stored as JSONB** — enables exact replay regardless of later data changes; also useful for audit.
- **Deterministic `event_id`** — `evt-{residentId}-{YYYY-MM-DD}` makes same-day double-clicks idempotent at the DB level.
- **Fire-and-forget first attempt** — the POST `/renewal-event` endpoint returns HTTP 202 immediately; delivery happens asynchronously via `setImmediate`.

---

## AI Usage Disclosure

This project was built end-to-end with **Claude Code (Claude Sonnet 4.6)** as the primary coding tool, directed by the developer.

**What AI did well:**
- Boilerplate scaffolding (Express middleware, pg.Pool patterns, Vite + Tailwind setup)
- SQL query construction (CTEs, `DISTINCT ON`, bulk parameterised `INSERT`)
- TypeScript type definitions and consistent interface shapes
- React component structure (loading/error states, expandable rows)
- Writing this documentation

**What required human refinement:**
- **Scoring formula calibration** — the spec example (45 days → 85 score) was internally inconsistent and couldn't be reverse-engineered. The developer designed the stepped scoring scale from scratch, then validated all four seed scenarios by hand before implementing.
- **Payment window off-by-one** — AI used `>` for the lower bound of the 6-month window instead of `>=`, causing the oldest monthly payment to be excluded. Caught during testing and fixed.
- **Missing seed payments** — initial quick-test seed didn't include payment records for two residents, making them incorrectly appear delinquent. Caught by manually checking scores against expectations.
- **MTM scoring decision** — the spec doesn't define how to score month-to-month leases. The developer chose a fixed 20/40 points (not max urgency, not zero), reasoning that MTM residents can leave any time but are not as immediately at risk as a fixed-term expiring in < 30 days. This required overriding AI's initial full-score suggestion.

**Trade-off summary:** AI significantly accelerated the implementation of known patterns (REST API structure, webhook retry logic, React data-fetching). Decisions that required domain judgment — scoring calibration, edge-case handling, idempotency strategy — still needed deliberate human input and testing.
