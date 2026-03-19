-- =============================================================================
-- Migration 001 — Initial Schema
-- Renewal Risk Detection System
-- =============================================================================
-- Run order: this file is idempotent via IF NOT EXISTS / CREATE OR REPLACE.
-- Execute with: psql $DATABASE_URL -f migrations/001_init.sql
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE risk_tier AS ENUM ('high', 'medium', 'low');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE webhook_status AS ENUM ('pending', 'delivered', 'failed', 'dlq');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- =============================================================================
-- Core Tables  (provided schema — structure must not change)
-- =============================================================================

CREATE TABLE IF NOT EXISTS properties (
  id         UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  name       VARCHAR(255) NOT NULL,
  address    VARCHAR(500),
  city       VARCHAR(100),
  state      VARCHAR(2),
  zip_code   VARCHAR(10),
  status     VARCHAR(50)  NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (name)
);

CREATE INDEX IF NOT EXISTS idx_properties_status ON properties (status);

-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS unit_types (
  id            UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  property_id   UUID        NOT NULL REFERENCES properties (id),
  name          VARCHAR(100) NOT NULL,
  bedrooms      INT,
  bathrooms     NUMERIC(3, 1),
  square_footage INT,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (property_id, name)
);

-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS units (
  id           UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  property_id  UUID        NOT NULL REFERENCES properties (id),
  unit_type_id UUID        NOT NULL REFERENCES unit_types (id),
  unit_number  VARCHAR(50)  NOT NULL,
  floor        INT,
  -- available | occupied | pending_move_out
  status       VARCHAR(50)  NOT NULL DEFAULT 'available',
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (property_id, unit_number)
);

CREATE INDEX IF NOT EXISTS idx_units_property_id ON units (property_id);
CREATE INDEX IF NOT EXISTS idx_units_status      ON units (status);

-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS unit_pricing (
  id             UUID       PRIMARY KEY DEFAULT uuid_generate_v4(),
  unit_id        UUID       NOT NULL REFERENCES units (id),
  base_rent      NUMERIC(10, 2) NOT NULL,
  market_rent    NUMERIC(10, 2) NOT NULL,
  effective_date DATE       NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (unit_id, effective_date)
);

CREATE INDEX IF NOT EXISTS idx_unit_pricing_unit_id        ON unit_pricing (unit_id);
CREATE INDEX IF NOT EXISTS idx_unit_pricing_effective_date ON unit_pricing (effective_date);

-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS residents (
  id            UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  property_id   UUID        NOT NULL REFERENCES properties (id),
  unit_id       UUID        NOT NULL REFERENCES units (id),
  first_name    VARCHAR(100) NOT NULL,
  last_name     VARCHAR(100) NOT NULL,
  email         VARCHAR(255),
  phone         VARCHAR(20),
  -- active | notice_given | moved_out
  status        VARCHAR(50)  NOT NULL DEFAULT 'active',
  move_in_date  DATE,
  move_out_date DATE,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_residents_property_id ON residents (property_id);
CREATE INDEX IF NOT EXISTS idx_residents_unit_id     ON residents (unit_id);
CREATE INDEX IF NOT EXISTS idx_residents_status      ON residents (status);

-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS leases (
  id               UUID           PRIMARY KEY DEFAULT uuid_generate_v4(),
  property_id      UUID           NOT NULL REFERENCES properties (id),
  resident_id      UUID           NOT NULL REFERENCES residents (id),
  unit_id          UUID           NOT NULL REFERENCES units (id),
  lease_start_date DATE           NOT NULL,
  lease_end_date   DATE           NOT NULL,
  monthly_rent     NUMERIC(10, 2) NOT NULL,
  -- fixed | month_to_month
  lease_type       VARCHAR(50)    NOT NULL DEFAULT 'fixed',
  -- active | expired | terminated
  status           VARCHAR(50)    NOT NULL DEFAULT 'active',
  created_at       TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_leases_property_id    ON leases (property_id);
CREATE INDEX IF NOT EXISTS idx_leases_resident_id    ON leases (resident_id);
CREATE INDEX IF NOT EXISTS idx_leases_lease_end_date ON leases (lease_end_date);
CREATE INDEX IF NOT EXISTS idx_leases_status         ON leases (status);

-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS resident_ledger (
  id               UUID           PRIMARY KEY DEFAULT uuid_generate_v4(),
  property_id      UUID           NOT NULL REFERENCES properties (id),
  resident_id      UUID           NOT NULL REFERENCES residents (id),
  -- charge | payment
  transaction_type VARCHAR(50)    NOT NULL,
  -- rent | late_fee | application_fee | etc.
  charge_code      VARCHAR(100),
  amount           NUMERIC(10, 2) NOT NULL,
  transaction_date DATE           NOT NULL,
  created_at       TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ledger_property_id       ON resident_ledger (property_id);
CREATE INDEX IF NOT EXISTS idx_ledger_resident_id       ON resident_ledger (resident_id);
CREATE INDEX IF NOT EXISTS idx_ledger_transaction_date  ON resident_ledger (transaction_date);
CREATE INDEX IF NOT EXISTS idx_ledger_transaction_type  ON resident_ledger (transaction_type);

-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS renewal_offers (
  id                   UUID           PRIMARY KEY DEFAULT uuid_generate_v4(),
  property_id          UUID           NOT NULL REFERENCES properties (id),
  resident_id          UUID           NOT NULL REFERENCES residents (id),
  lease_id             UUID           NOT NULL REFERENCES leases (id),
  renewal_start_date   DATE           NOT NULL,
  renewal_end_date     DATE,
  proposed_rent        NUMERIC(10, 2),
  offer_expiration_date DATE,
  -- pending | accepted | declined | expired
  status               VARCHAR(50)    NOT NULL DEFAULT 'pending',
  created_at           TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_renewal_offers_property_id ON renewal_offers (property_id);
CREATE INDEX IF NOT EXISTS idx_renewal_offers_resident_id ON renewal_offers (resident_id);
CREATE INDEX IF NOT EXISTS idx_renewal_offers_status      ON renewal_offers (status);

-- =============================================================================
-- Renewal Risk Tables  (candidate-designed)
-- =============================================================================

-- One row per resident per calculation run (append-only).
-- Preserves full scoring history; the dashboard always reads the latest row
-- per resident via the (property_id, calculated_at DESC) index.
--
-- Signals are flat columns (not JSON) so they remain queryable for analytics
-- ("what % of flagged residents had a payment issue?").
--
-- calculated_at is set to the asOfDate from the API request, not auto-NOW(),
-- so historical recalculations are correctly attributed.
CREATE TABLE IF NOT EXISTS renewal_risk_scores (
  id                      UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  property_id             UUID        NOT NULL REFERENCES properties (id),
  resident_id             UUID        NOT NULL REFERENCES residents (id),
  lease_id                UUID        NOT NULL REFERENCES leases (id),
  -- 0–100 composite score
  risk_score              INT         NOT NULL CHECK (risk_score BETWEEN 0 AND 100),
  risk_tier               risk_tier   NOT NULL,
  -- Raw signal values captured at calculation time for auditability
  days_to_expiry          INT,
  payment_delinquent      BOOLEAN     NOT NULL DEFAULT FALSE,
  no_renewal_offer        BOOLEAN     NOT NULL DEFAULT FALSE,
  rent_growth_above_market BOOLEAN    NOT NULL DEFAULT FALSE,
  -- Explicit; set to the asOfDate from the API request
  calculated_at           TIMESTAMPTZ NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Primary access pattern: "get latest scores for property X"
CREATE INDEX IF NOT EXISTS idx_risk_scores_property_calc
  ON renewal_risk_scores (property_id, calculated_at DESC);

-- Dashboard tier filter
CREATE INDEX IF NOT EXISTS idx_risk_scores_property_tier
  ON renewal_risk_scores (property_id, risk_tier);

-- ---------------------------------------------------------------------------

-- Tracks every webhook delivery attempt with full retry state.
--
-- event_id UNIQUE is the idempotency key — prevents inserting a second
-- delivery record for the same logical event even under concurrent requests.
--
-- Full payload stored as JSONB so it can be replayed exactly as-is,
-- regardless of later changes to resident/lease records.
CREATE TABLE IF NOT EXISTS webhook_delivery_state (
  id             UUID           PRIMARY KEY DEFAULT uuid_generate_v4(),
  -- Idempotency key: generated once per event, reused on UI re-clicks
  event_id       VARCHAR(100)   NOT NULL UNIQUE,
  property_id    UUID           NOT NULL REFERENCES properties (id),
  resident_id    UUID           NOT NULL REFERENCES residents (id),
  event_type     VARCHAR(100)   NOT NULL DEFAULT 'renewal.risk_flagged',
  -- Full payload stored for replay / debugging
  payload        JSONB          NOT NULL,
  status         webhook_status NOT NULL DEFAULT 'pending',
  -- Incremented on every attempt; capped at 5 before DLQ promotion
  attempt_count  INT            NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMPTZ,
  -- NULL until first failure; drives the retry worker poll query
  next_retry_at  TIMESTAMPTZ,
  -- Last raw response body from the RMS for debugging
  rms_response   TEXT,
  created_at     TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

-- Retry worker poll: WHERE status = 'pending' AND next_retry_at <= NOW()
CREATE INDEX IF NOT EXISTS idx_webhook_status_retry
  ON webhook_delivery_state (status, next_retry_at);

CREATE INDEX IF NOT EXISTS idx_webhook_property_id
  ON webhook_delivery_state (property_id);

-- ---------------------------------------------------------------------------

-- Permanent failure log.
-- A row is inserted here in the SAME transaction that sets status = 'dlq',
-- so the promotion is atomic. The UNIQUE FK enforces 1-to-1 — a webhook
-- can only be dead-lettered once.
CREATE TABLE IF NOT EXISTS webhook_dead_letter_queue (
  id                       UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  webhook_delivery_state_id UUID       NOT NULL UNIQUE
                                         REFERENCES webhook_delivery_state (id),
  -- 'max_retries_exceeded' | 'permanent_error'
  reason                   TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
