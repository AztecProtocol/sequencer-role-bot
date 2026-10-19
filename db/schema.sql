-- Tables used by bot.js, cronJob.js and db/signatureAttempts.js.
-- Every statement is idempotent, so the file is safe to run on each start.

CREATE TABLE IF NOT EXISTS pending_registrations (
  id                       SERIAL PRIMARY KEY,
  discord_user_id          TEXT NOT NULL,
  discord_username         TEXT,
  network                  TEXT NOT NULL,
  wallet_address           TEXT NOT NULL,
  message_to_sign          TEXT NOT NULL,
  signature                TEXT,
  status                   TEXT NOT NULL DEFAULT 'pending',
  retry_count              INTEGER NOT NULL DEFAULT 0,
  last_error               TEXT,
  last_notification_status TEXT,
  -- Time of the first inactive reading. The removal countdown starts here.
  at_risk_since            TIMESTAMPTZ,
  expires_at               TIMESTAMPTZ NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- One registration per user and network. bot.js updates the row on conflict.
  UNIQUE (discord_user_id, network)
);

-- Added after the first release of the schema.
ALTER TABLE pending_registrations ADD COLUMN IF NOT EXISTS at_risk_since TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS signature_attempts (
  id                  SERIAL PRIMARY KEY,
  discord_user_id     TEXT NOT NULL,
  discord_username    TEXT,
  network             TEXT NOT NULL,
  wallet_address      TEXT NOT NULL,
  timestamp_generated BIGINT NOT NULL,
  attempt_count       INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS signature_attempts_user_created_idx
  ON signature_attempts (discord_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS colleagues (
  id                 SERIAL PRIMARY KEY,
  manager_discord_id TEXT NOT NULL,
  manager_username   TEXT,
  colleague_user_id  TEXT NOT NULL,
  colleague_username TEXT,
  status             TEXT NOT NULL DEFAULT 'active',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS colleagues_manager_idx
  ON colleagues (manager_discord_id);

-- Provider registrations: a provider admin or rewards recipient proves control
-- of a provider in the StakingRegistry. See docs/superpowers/specs.
CREATE TABLE IF NOT EXISTS provider_registrations (
  id                       SERIAL PRIMARY KEY,
  discord_user_id          TEXT NOT NULL,
  discord_username         TEXT,
  network                  TEXT NOT NULL,
  -- StakingRegistry address (lower case) that the registration was made for.
  registry                 TEXT NOT NULL,
  provider_id              INTEGER NOT NULL,
  signer_address           TEXT NOT NULL,
  signer_kind              TEXT NOT NULL,
  message_to_sign          TEXT NOT NULL,
  signature                TEXT,
  status                   TEXT NOT NULL DEFAULT 'pending',
  at_risk_since            TIMESTAMPTZ,
  last_notification_status TEXT,
  expires_at               TIMESTAMPTZ NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (discord_user_id, network, registry, provider_id)
);

-- Index of StakedWithProvider events. network and registry (the StakingRegistry
-- address) are lower case here.
CREATE TABLE IF NOT EXISTS provider_attesters (
  network     TEXT NOT NULL,
  registry    TEXT NOT NULL,
  provider_id INTEGER NOT NULL,
  attester    TEXT NOT NULL,
  PRIMARY KEY (network, registry, provider_id, attester)
);

-- Last block read for each contract event scan.
CREATE TABLE IF NOT EXISTS event_cursors (
  network    TEXT NOT NULL,
  contract   TEXT NOT NULL,
  last_block BIGINT NOT NULL,
  PRIMARY KEY (network, contract)
);
