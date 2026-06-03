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
    subscription_period_end  BIGINT
  )`,
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
