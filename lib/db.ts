// Postgres (Neon) client + schema bootstrap.
//
// This is the foundation for real multi-user accounts: profiles, per-user
// note storage, and the subscription/credits columns that billing will later
// build on. We talk to Neon over its HTTP driver, which works in both the
// Node and Edge runtimes without a connection pool to manage.
//
// Connection string resolution (first match wins):
//   DATABASE_URL  → standard Neon / generic Postgres URL
//   POSTGRES_URL  → the var Vercel's Postgres/Neon integration injects
//
// When NEITHER is set, `pgConfigured()` is false and callers fall back to
// their previous backends (Vercel KV in prod, JSON files in dev). That keeps
// the app working before Postgres is provisioned, and lets the storage
// modules lazily migrate KV data into Postgres once it is.
//
// Server-only — never import from a client component.

import "server-only";
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

function connectionString(): string | null {
  return process.env.DATABASE_URL || process.env.POSTGRES_URL || null;
}

export function pgConfigured(): boolean {
  return !!connectionString();
}

// Lazily-created singleton. The Neon HTTP client is cheap and stateless, but
// we still memoise it so we don't re-parse the URL on every call.
let _sql: NeonQueryFunction<false, false> | null = null;

export function sql(): NeonQueryFunction<false, false> {
  if (_sql) return _sql;
  const url = connectionString();
  if (!url) throw new Error("Postgres non configurato (manca DATABASE_URL).");
  _sql = neon(url);
  return _sql;
}

// ── Schema ──
//
// Idempotent: safe to call on every cold start. We DON'T run this in a
// migration step (no separate tooling) — instead `ensureSchema()` is invoked
// once per process via `withSchema()` below, guarded by an in-memory flag so
// the CREATEs only fire on the first DB-touching request after a deploy.
//
// `users.id` is the account handle = lowercased email (or, for pre-email
// legacy accounts, the original username). It matches the JWT subject so no
// id↔email lookup is needed on hot paths.
//
// Credits/subscription columns are part of the foundation but NOT yet
// enforced anywhere — billing wiring comes in a later step.
// One statement per array entry — Neon's HTTP driver executes a single
// statement per round-trip, so we can't send the whole script in one call.
// Every statement is independently idempotent (IF NOT EXISTS), so running
// them sequentially on each cold start is safe.
const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS users (
    id                       TEXT PRIMARY KEY,
    email                    TEXT,
    first_name               TEXT NOT NULL DEFAULT '',
    last_name                TEXT NOT NULL DEFAULT '',
    password_hash            TEXT NOT NULL DEFAULT '',
    google_sub               TEXT,
    created_at               BIGINT NOT NULL,
    plan                     TEXT NOT NULL DEFAULT 'free',
    credits                  INTEGER NOT NULL DEFAULT 0,
    monthly_credits          INTEGER NOT NULL DEFAULT 0,
    credits_period_start     BIGINT,
    stripe_customer_id       TEXT,
    subscription_status      TEXT,
    subscription_period_end  BIGINT,
    onboarded_at             BIGINT,
    enhance_templates        JSONB NOT NULL DEFAULT '[]'::jsonb
  )`,
  // Idempotent migrations for deploys that already ran an older schema.
  // Safe to re-run on every cold start.
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarded_at BIGINT`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS enhance_templates JSONB NOT NULL DEFAULT '[]'::jsonb`,
  `CREATE TABLE IF NOT EXISTS notes (
    id            TEXT NOT NULL,
    user_id       TEXT NOT NULL,
    title         TEXT NOT NULL DEFAULT '',
    body          TEXT NOT NULL DEFAULT '',
    transcript    TEXT NOT NULL DEFAULT '',
    enhanced_html TEXT NOT NULL DEFAULT '',
    created_at    BIGINT NOT NULL,
    updated_at    BIGINT NOT NULL,
    manual_title  BOOLEAN NOT NULL DEFAULT FALSE,
    pinned        BOOLEAN NOT NULL DEFAULT FALSE,
    split_ratio   REAL,
    ask_messages  JSONB NOT NULL DEFAULT '[]'::jsonb,
    deleted_at    BIGINT,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS notes_user_idx ON notes (user_id)`,

  // ── Billing tables ──
  //
  // `plans` and `credit_costs` are intentionally separate from code so the
  // operator can change pricing / allowances / per-op costs with a single
  // UPDATE — no redeploy. Both tables get a small set of defaults seeded
  // (see SEED_STATEMENTS below) the first time the schema runs, then the
  // operator's edits are preserved (the seed uses ON CONFLICT DO NOTHING).
  //
  // `credit_transactions` is the append-only audit log. Every grant
  // (registration bonus, monthly reset, Stripe top-up) and every consumption
  // (enhance / ask / transcribe) writes one row, with `balance_after` so we
  // can reconstruct the user's history without re-aggregating.
  `CREATE TABLE IF NOT EXISTS plans (
    id                   TEXT PRIMARY KEY,
    display_name         TEXT NOT NULL,
    monthly_credits      INTEGER NOT NULL DEFAULT 0,
    stripe_price_id      TEXT,
    is_active            BOOLEAN NOT NULL DEFAULT TRUE,
    position             INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS credit_costs (
    operation            TEXT PRIMARY KEY,
    cost                 INTEGER NOT NULL DEFAULT 0,
    description          TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS credit_transactions (
    id                   BIGSERIAL PRIMARY KEY,
    user_id              TEXT NOT NULL,
    operation            TEXT NOT NULL,
    amount               INTEGER NOT NULL,
    balance_after        INTEGER NOT NULL,
    metadata             JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at           BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS credit_tx_user_idx ON credit_transactions (user_id, created_at DESC)`,
];

// ── Seed defaults ──
//
// First-time setup: a free plan with a small allowance so new users can try
// the app, a placeholder pro plan to be configured once you wire Stripe, and
// a default cost of 1 credit per operation. All are ON CONFLICT DO NOTHING:
// once you change them with UPDATE, your edits stick across redeploys.
// Update the costs/allowances directly with SQL when you have your numbers —
// no code change needed.
const SEED_STATEMENTS: string[] = [
  `INSERT INTO plans (id, display_name, monthly_credits, position) VALUES
     ('free', 'Free', 20, 0),
     ('pro',  'Pro',  500, 1)
   ON CONFLICT (id) DO NOTHING`,
  `INSERT INTO credit_costs (operation, cost, description) VALUES
     ('enhance', 1, 'Una operazione di Enhance AI'),
     ('ask',     1, 'Una domanda ad Ask AI'),
     ('transcribe', 1, 'Una trascrizione (file o registrazione)')
   ON CONFLICT (operation) DO NOTHING`,
];

let schemaReady: Promise<void> | null = null;

// Runs the schema once per process. Concurrent callers share the same
// in-flight promise so we never issue the CREATEs more than once.
export function ensureSchema(): Promise<void> {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    const client = sql();
    for (const stmt of SCHEMA_STATEMENTS) {
      await client.query(stmt);
    }
    for (const stmt of SEED_STATEMENTS) {
      await client.query(stmt);
    }
  })().catch((err) => {
    // Reset so a transient failure (cold DB, network) can be retried on the
    // next request instead of being cached as "done".
    schemaReady = null;
    throw err;
  });
  return schemaReady;
}

// Convenience wrapper: ensure the schema exists, then hand back the client.
export async function db(): Promise<NeonQueryFunction<false, false>> {
  await ensureSchema();
  return sql();
}
