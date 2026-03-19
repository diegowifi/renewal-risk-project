# Backend — Renewal Risk Detection

## Stack

- **Runtime**: Node.js + TypeScript
- **Framework**: Express
- **Database client**: `pg` (node-postgres)
- **Database**: PostgreSQL 16

---

## Schema Design Decisions

### Migration file

`migrations/001_init.sql` is the single deliverable migration. It is idempotent
(`IF NOT EXISTS`, `DO $$ … EXCEPTION WHEN duplicate_object`) and can be re-run
safely. Apply with:

```bash
psql $DATABASE_URL -f migrations/001_init.sql
```

---

### Batch job: sync vs. async

The `POST /renewal-risk/calculate` endpoint runs **synchronously** and returns
the full result in the HTTP response body. This is the right tradeoff for the
current scale:

- A single CTE + bulk INSERT completes in well under 1 second for 5 000
  residents in a locally-hosted PostgreSQL.
- Synchronous execution keeps the API contract simple (no polling, no job IDs)
  and makes errors immediately visible to the caller.
- If the dataset grew into the tens of thousands, the obvious migration path is
  to return HTTP 202 + a job ID and persist results asynchronously — but that
  extra complexity isn't warranted yet.

---

### Query performance at scale (5 000+ residents)

The fetch query is a **single CTE round-trip** that joins residents, leases,
unit pricing, renewal offers, and payment counts in one statement.  Key
characteristics that keep it fast:

- **No N+1** — all signal data is collected in the CTE before the application
  layer sees any rows.
- **Index-aligned filters** — every WHERE clause in the CTEs hits a leading
  indexed column (`property_id`, `resident_id`, `unit_id`).
- **Bulk INSERT** — all score rows are written in one parameterised
  `INSERT … VALUES (…), (…), …` statement rather than N individual INSERTs.
- **`pg_advisory_xact_lock`** — prevents two concurrent runs from inserting
  duplicate score rows for the same property, without a separate lock table.

For a property with 5 000 residents the query plan stays an index scan + hash
join; there is no table scan.

---

### Core Tables (from `starter_schema.sql`)

Reproduced verbatim in `001_init.sql`. The only upgrade is using `TIMESTAMPTZ`
instead of bare `TIMESTAMP` — time-zone-aware storage is a PostgreSQL best practice.

---

### New Table: `renewal_risk_scores`

**Append-only (one row per resident per run)**

Each calculation run inserts fresh rows rather than overwriting. This preserves
a full scoring history for audit and trend analysis. The dashboard reads the
latest row per resident via the `(property_id, calculated_at DESC)` index.

**Signals as flat columns, not JSON**

`payment_delinquent`, `no_renewal_offer`, `rent_growth_above_market`,
`days_to_expiry` are first-class columns. This enables future aggregation
("what % of flagged residents had a payment issue?"), DB-level type safety,
and simpler application reads.

**`calculated_at` is set explicitly**

The API accepts an `asOfDate` parameter; `calculated_at` is set to that value,
not `NOW()`, so historical recalculations are correctly attributed.

**Indexes**
- `(property_id, calculated_at DESC)` — primary pattern: latest scores for property X
- `(property_id, risk_tier)` — dashboard tier filter

---

### New Table: `webhook_delivery_state`

**Idempotency via `event_id UNIQUE`**

`event_id` is a stable key generated once per logical event. The `UNIQUE`
constraint prevents a second delivery record for the same event, even under
concurrent requests.

**Full payload stored as JSONB**

Stored at creation time so it can be replayed exactly regardless of subsequent
changes to resident or lease data. Critical for audit trails.

**`next_retry_at` drives the retry worker**

The background retry worker polls:
```sql
WHERE status = 'pending' AND next_retry_at <= NOW()
```
The `(status, next_retry_at)` index makes this efficient.

**State transitions (atomic)**
```
pending → delivered   (success on any attempt)
pending → dlq         (5 failures; DLQ insert + status update in one transaction)
```

---

### New Table: `webhook_dead_letter_queue`

Append-only log. Inserted in the **same transaction** as the `status = 'dlq'`
update, so promotion is atomic. The `UNIQUE` FK enforces 1-to-1 — a webhook
can only be dead-lettered once.

---

### Multi-tenancy

All tables carry `property_id`. Every query filters by `property_id` first,
matching the leading column of all relevant indexes. No cross-property data
leaks regardless of total row count.

---

### Webhook Request Signing

Each outbound webhook includes:
```
X-Webhook-Signature: sha256=<hex>
```
Computed as `HMAC-SHA256(raw_body, WEBHOOK_SECRET)`. The RMS should:
1. Read the raw request body before JSON parsing
2. Compute `HMAC-SHA256(body, shared_secret)`
3. Compare with the header using a constant-time comparison

---

## Edge Cases

| Scenario | Decision |
|---|---|
| RMS unreachable | Retry with exponential backoff (1 s, 2 s, 4 s, 8 s, 16 s); DLQ after 5 failures |
| Lease already expired | Excluded from calculation — query filters `leases.status = 'active'` |
| Month-to-month lease | Fixed days-to-expiry score of 20/40. MTM residents can leave at any time (moderate urgency) but are not as immediately critical as a fixed-term lease expiring in ≤ 30 days (which scores 40/40). |
| No market rent data | Rent growth signal = 0; calculation continues |
| Concurrent batch jobs | `pg_advisory_xact_lock` scoped to the property prevents simultaneous runs |
| Same event triggered twice | `event_id UNIQUE` rejects the duplicate at the DB level |

---

## Running Locally

```bash
# Start the database
docker-compose up -d          # PostgreSQL on port 5433
# — or use a local PostgreSQL on port 5432 (update DATABASE_URL in .env)

# Apply the schema
psql $DATABASE_URL -f migrations/001_init.sql

# Seed sample data
npm run seed

# Start dev server (hot reload)
npm run dev
```
