// Credits & billing — runtime configuration is in the DB.
//
// Three pieces of state, all changeable without a redeploy:
//   plans            id, display_name, monthly_credits, stripe_price_id, is_active
//   credit_costs     operation → cost in credits
//   credit_transactions  append-only audit log
//
// You can leave the seeded defaults in place and change them later with:
//   UPDATE plans SET monthly_credits = 200 WHERE id = 'pro';
//   UPDATE credit_costs SET cost = 2 WHERE operation = 'enhance';
//   INSERT INTO plans (id, display_name, monthly_credits, position)
//     VALUES ('plus', 'Plus', 150, 2);
// New users / next reset / next operation pick the new values up automatically
// (with a brief in-memory cache to keep hot paths cheap).
//
// When Postgres ISN'T configured, every entry point here returns "ok / no
// enforcement". That keeps email/password + notes working in dev without DB,
// and lets the rest of the app degrade gracefully if the DB is unreachable.
//
// Server-only — never import from a client component.

import "server-only";
import { db, pgConfigured } from "@/lib/db";

// ── Types ──
export interface Plan {
  id: string;
  displayName: string;
  monthlyCredits: number;
  stripePriceId: string | null;
  isActive: boolean;
  position: number;
}

export interface ConsumeResult {
  ok: boolean;
  /** When ok=false, why: 'no_db' (billing disabled), 'plan_unknown',
   *  'cost_unknown', 'insufficient'. */
  reason?: "no_db" | "plan_unknown" | "cost_unknown" | "insufficient";
  /** Cost the operation would have / did consume. 0 when ok=false because
   *  billing isn't active (so the caller can render "free / unlimited"). */
  cost: number;
  /** Balance after the consumption attempt — i.e. the user's current balance
   *  for both ok=true (after debit) and ok=false (unchanged). null when DB
   *  isn't configured. */
  balance: number | null;
}

// ── Defaults (used if a plan / cost row is missing) ──
const FALLBACK_PLAN: Plan = {
  id: "free",
  displayName: "Free",
  monthlyCredits: 0,
  stripePriceId: null,
  isActive: true,
  position: 0,
};
const FALLBACK_COST = 1;

// ── Tiny in-memory caches ──
// Plans + costs are read on every billable request; without a cache that's
// one DB round-trip per call. 60 s is short enough that operator edits go
// live within a minute, long enough to absorb bursts.
const CACHE_TTL_MS = 60_000;
const planCache = new Map<string, { value: Plan | null; expiresAt: number }>();
const costCache = new Map<string, { value: number | null; expiresAt: number }>();

interface PlanRow {
  id: string;
  display_name: string;
  monthly_credits: number;
  stripe_price_id: string | null;
  is_active: boolean;
  position: number;
}
interface CostRow {
  operation: string;
  cost: number;
}
interface UserBalanceRow {
  credits: number;
  plan: string | null;
  monthly_credits: number;
  credits_period_start: string | number | null;
}

function now(): number { return Date.now(); }

export async function getPlan(id: string): Promise<Plan | null> {
  if (!pgConfigured()) return null;
  const key = id.toLowerCase();
  const hit = planCache.get(key);
  if (hit && hit.expiresAt > now()) return hit.value;
  const client = await db();
  const rows = (await client`SELECT id, display_name, monthly_credits, stripe_price_id, is_active, position FROM plans WHERE id = ${key}`) as PlanRow[];
  const value: Plan | null = rows[0]
    ? {
        id: rows[0].id,
        displayName: rows[0].display_name,
        monthlyCredits: rows[0].monthly_credits,
        stripePriceId: rows[0].stripe_price_id,
        isActive: rows[0].is_active,
        position: rows[0].position,
      }
    : null;
  planCache.set(key, { value, expiresAt: now() + CACHE_TTL_MS });
  return value;
}

/** Locate a plan by its Stripe price id. Used by the webhook so the operator
 *  doesn't have to maintain a parallel mapping. */
export async function getPlanByStripePriceId(priceId: string): Promise<Plan | null> {
  if (!pgConfigured() || !priceId) return null;
  const client = await db();
  const rows = (await client`
    SELECT id, display_name, monthly_credits, stripe_price_id, is_active, position
    FROM plans WHERE stripe_price_id = ${priceId}
  `) as PlanRow[];
  if (!rows[0]) return null;
  return {
    id: rows[0].id,
    displayName: rows[0].display_name,
    monthlyCredits: rows[0].monthly_credits,
    stripePriceId: rows[0].stripe_price_id,
    isActive: rows[0].is_active,
    position: rows[0].position,
  };
}

export async function listActivePlans(): Promise<Plan[]> {
  if (!pgConfigured()) return [];
  const client = await db();
  const rows = (await client`
    SELECT id, display_name, monthly_credits, stripe_price_id, is_active, position
    FROM plans WHERE is_active = TRUE ORDER BY position ASC, id ASC
  `) as PlanRow[];
  return rows.map((r) => ({
    id: r.id,
    displayName: r.display_name,
    monthlyCredits: r.monthly_credits,
    stripePriceId: r.stripe_price_id,
    isActive: r.is_active,
    position: r.position,
  }));
}

export async function getCreditCost(operation: string): Promise<number | null> {
  if (!pgConfigured()) return null;
  const key = operation.toLowerCase();
  const hit = costCache.get(key);
  if (hit && hit.expiresAt > now()) return hit.value;
  const client = await db();
  const rows = (await client`SELECT operation, cost FROM credit_costs WHERE operation = ${key}`) as CostRow[];
  const value: number | null = rows[0]?.cost ?? null;
  costCache.set(key, { value, expiresAt: now() + CACHE_TTL_MS });
  return value;
}

// Clears the in-memory caches. Useful from an admin endpoint after editing
// the plans/costs tables if you don't want to wait 60 s for the cache TTL.
export function invalidateBillingCaches(): void {
  planCache.clear();
  costCache.clear();
}

// ── Monthly reset (lazy) ──
//
// We don't run a cron. Instead, every billable request and every /api/auth/me
// hit calls `applyMonthlyReset` for the current user. If 30 d have elapsed
// since `credits_period_start`, we replenish credits to the plan's
// monthly_credits and advance the period. This converges to identical
// behaviour as a cron while avoiding the operational baggage of one.
const PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * If the user's current period is older than 30 days, replenish their credits
 * to their plan's monthly_credits and advance the period start. No-op for
 * users without a plan or with PG disabled.
 *
 * Idempotent: runs the WHERE-guard inside the UPDATE so concurrent calls
 * don't double-credit a user.
 */
export async function applyMonthlyReset(userId: string): Promise<void> {
  if (!userId || !pgConfigured()) return;
  const client = await db();
  const uid = userId.trim().toLowerCase();
  const rows = (await client`
    SELECT plan, credits_period_start FROM users WHERE id = ${uid}
  `) as { plan: string | null; credits_period_start: string | number | null }[];
  const row = rows[0];
  if (!row) return;
  const planId = row.plan || "free";
  const plan = (await getPlan(planId)) ?? FALLBACK_PLAN;
  if (plan.monthlyCredits <= 0) return; // nothing to refill

  const start = row.credits_period_start != null ? Number(row.credits_period_start) : 0;
  const t = now();
  // No period start yet (legacy account migrated mid-cycle) — kickstart it.
  if (!start) {
    await client`
      UPDATE users
        SET credits = ${plan.monthlyCredits},
            monthly_credits = ${plan.monthlyCredits},
            credits_period_start = ${t}
      WHERE id = ${uid} AND credits_period_start IS NULL
    `;
    await logTransaction(uid, "monthly_init", plan.monthlyCredits, plan.monthlyCredits, { plan: plan.id });
    return;
  }
  if (t - start < PERIOD_MS) return;

  // Replenish: credits = monthlyCredits (don't accumulate — the cap == cap).
  // Advance period by however many full periods elapsed so a long-dormant
  // account doesn't get N months of credits at once.
  const periodsElapsed = Math.floor((t - start) / PERIOD_MS);
  const newPeriodStart = start + periodsElapsed * PERIOD_MS;
  const result = (await client`
    UPDATE users
      SET credits = ${plan.monthlyCredits},
          monthly_credits = ${plan.monthlyCredits},
          credits_period_start = ${newPeriodStart}
    WHERE id = ${uid} AND credits_period_start = ${start}
    RETURNING credits
  `) as { credits: number }[];
  if (result.length > 0) {
    await logTransaction(uid, "monthly_reset", plan.monthlyCredits, plan.monthlyCredits, {
      plan: plan.id,
      periodsElapsed,
    });
  }
}

// ── Grants ──
//
// Called when a new account is created (welcome credits) or when a top-up
// happens (Stripe webhook will use this in the next step).

export async function grantInitialCredits(userId: string, planId = "free"): Promise<void> {
  if (!pgConfigured()) return;
  const plan = (await getPlan(planId)) ?? FALLBACK_PLAN;
  const client = await db();
  const uid = userId.trim().toLowerCase();
  // Only stamp credits on a brand-new user. If they already have a period
  // start, leave them alone (re-running register from some weird state
  // shouldn't reset their balance).
  const result = (await client`
    UPDATE users
      SET plan = ${plan.id},
          credits = ${plan.monthlyCredits},
          monthly_credits = ${plan.monthlyCredits},
          credits_period_start = ${now()}
    WHERE id = ${uid} AND credits_period_start IS NULL
    RETURNING credits
  `) as { credits: number }[];
  if (result.length > 0) {
    await logTransaction(uid, "welcome", plan.monthlyCredits, plan.monthlyCredits, { plan: plan.id });
  }
}

// ── Atomic consume ──
//
// Single round-trip: `UPDATE … SET credits = credits - cost WHERE credits >=
// cost RETURNING credits`. Postgres serialises updates to the same row, so
// two parallel requests can't both succeed against the same last credit.
export async function consumeCredits(
  userId: string,
  operation: string
): Promise<ConsumeResult> {
  // PG not configured → no enforcement. Caller proceeds with the operation.
  if (!pgConfigured()) {
    return { ok: true, cost: 0, balance: null };
  }
  if (!userId) {
    return { ok: false, reason: "plan_unknown", cost: 0, balance: null };
  }

  // Lazily replenish before checking the balance — otherwise a user whose
  // 30 days just elapsed would be blocked until their next /api/auth/me hit.
  await applyMonthlyReset(userId);

  const cost = await getCreditCost(operation);
  if (cost == null) {
    // Cost not configured → don't enforce (degrade open rather than break a
    // legitimate request). Log so the operator sees that this op needs a
    // seed row.
    console.warn(`consumeCredits: no cost configured for '${operation}', allowing`);
    return { ok: true, cost: 0, balance: null };
  }
  if (cost <= 0) {
    // Operation is configured as free.
    const bal = await getCurrentBalance(userId);
    return { ok: true, cost: 0, balance: bal };
  }

  const client = await db();
  const uid = userId.trim().toLowerCase();
  const rows = (await client`
    UPDATE users SET credits = credits - ${cost}
    WHERE id = ${uid} AND credits >= ${cost}
    RETURNING credits
  `) as { credits: number }[];

  if (rows.length === 0) {
    // Insufficient — read the current balance so the caller can surface it.
    const bal = await getCurrentBalance(userId);
    return { ok: false, reason: "insufficient", cost, balance: bal };
  }

  const newBalance = rows[0].credits;
  await logTransaction(uid, operation, -cost, newBalance, {});
  return { ok: true, cost, balance: newBalance };
}

/**
 * Reverse a previous `consumeCredits` debit. Used when the underlying LLM
 * provider call fails AFTER we already reserved the credit — the user shouldn't
 * pay for a request the system couldn't complete. No-op when PG is off.
 *
 * Idempotent at the audit layer (each refund writes one transaction) but the
 * caller must only invoke it once per failed consume.
 */
export async function refundCredits(
  userId: string,
  operation: string,
  amount: number
): Promise<void> {
  if (!pgConfigured() || !userId || amount <= 0) return;
  try {
    const client = await db();
    const uid = userId.trim().toLowerCase();
    const rows = (await client`
      UPDATE users SET credits = credits + ${amount}
      WHERE id = ${uid}
      RETURNING credits
    `) as { credits: number }[];
    if (rows.length > 0) {
      await logTransaction(uid, `${operation}_refund`, amount, rows[0].credits, {});
    }
  } catch (err) {
    console.warn("Refund failed (operation already debited):", err);
  }
}

export async function getCurrentBalance(userId: string): Promise<number | null> {
  if (!pgConfigured() || !userId) return null;
  const client = await db();
  const uid = userId.trim().toLowerCase();
  const rows = (await client`SELECT credits FROM users WHERE id = ${uid}`) as { credits: number }[];
  return rows[0]?.credits ?? null;
}

export async function getBillingSnapshot(userId: string): Promise<{
  plan: Plan;
  credits: number;
  monthlyCredits: number;
  creditsPeriodStart: number | null;
  onboardedAt: number | null;
} | null> {
  if (!pgConfigured() || !userId) return null;
  await applyMonthlyReset(userId);
  const client = await db();
  const uid = userId.trim().toLowerCase();
  const rows = (await client`
    SELECT credits, plan, monthly_credits, credits_period_start, onboarded_at
    FROM users WHERE id = ${uid}
  `) as Array<UserBalanceRow & { onboarded_at: string | number | null }>;
  const row = rows[0];
  if (!row) return null;
  const planId = row.plan || "free";
  const plan = (await getPlan(planId)) ?? FALLBACK_PLAN;
  return {
    plan,
    credits: row.credits ?? 0,
    monthlyCredits: row.monthly_credits ?? 0,
    creditsPeriodStart: row.credits_period_start != null ? Number(row.credits_period_start) : null,
    onboardedAt: row.onboarded_at != null ? Number(row.onboarded_at) : null,
  };
}

// ── Audit log ──
async function logTransaction(
  userId: string,
  operation: string,
  amount: number,
  balanceAfter: number,
  metadata: Record<string, unknown>
): Promise<void> {
  if (!pgConfigured()) return;
  try {
    const client = await db();
    const meta = JSON.stringify(metadata);
    await client`
      INSERT INTO credit_transactions (user_id, operation, amount, balance_after, metadata, created_at)
      VALUES (${userId}, ${operation}, ${amount}, ${balanceAfter}, ${meta}::jsonb, ${now()})
    `;
  } catch (err) {
    // Audit failures must never block the user — log and move on.
    console.warn("Credit transaction log failed:", err);
  }
}

// ── Stripe webhook hooks ──
//
// Called by /api/billing/webhook when the subscription state changes. These
// are intentionally generic — they don't know about Stripe types or events,
// just the local effects we want. The webhook handler translates Stripe
// events into one of these calls.

/**
 * The user just paid (a new subscription started, or an invoice renewed).
 * Switch them to the given plan, top up credits to the plan's
 * monthly_credits, and stamp the period boundary.
 */
export async function activateSubscription(
  userId: string,
  planId: string,
  subscriptionStatus: string,
  periodEndMs: number
): Promise<void> {
  if (!pgConfigured() || !userId) return;
  const plan = (await getPlan(planId)) ?? FALLBACK_PLAN;
  const client = await db();
  const uid = userId.trim().toLowerCase();
  const t = now();
  const rows = (await client`
    UPDATE users
      SET plan = ${plan.id},
          credits = ${plan.monthlyCredits},
          monthly_credits = ${plan.monthlyCredits},
          credits_period_start = ${t},
          subscription_status = ${subscriptionStatus},
          subscription_period_end = ${periodEndMs}
    WHERE id = ${uid}
    RETURNING credits
  `) as { credits: number }[];
  if (rows.length > 0) {
    await logTransaction(uid, "subscription_renewal", plan.monthlyCredits, plan.monthlyCredits, {
      plan: plan.id,
      status: subscriptionStatus,
    });
  }
}

/**
 * Subscription canceled / lapsed. Revert to the free plan (so the user
 * doesn't lose access entirely) and let the next monthly reset replenish
 * with the free allowance.
 */
export async function deactivateSubscription(
  userId: string,
  reason: "canceled" | "payment_failed" | "lapsed"
): Promise<void> {
  if (!pgConfigured() || !userId) return;
  const freePlan = (await getPlan("free")) ?? FALLBACK_PLAN;
  const client = await db();
  const uid = userId.trim().toLowerCase();
  await client`
    UPDATE users
      SET plan = ${freePlan.id},
          monthly_credits = ${freePlan.monthlyCredits},
          subscription_status = ${reason},
          subscription_period_end = NULL
    WHERE id = ${uid}
  `;
  await logTransaction(uid, `subscription_${reason}`, 0, 0, { reason });
}

// Expose the fallback so callers (e.g. UI rendering when PG is off) can reason
// about "what the user would have gotten" even when billing isn't active.
export { FALLBACK_PLAN, FALLBACK_COST };
