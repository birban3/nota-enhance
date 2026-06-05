// User profile: subscription plan + credit balance.
//
// This is the read side of the billing foundation. The columns live on the
// `users` table (lib/db.ts); nothing here enforces or charges anything yet —
// that's a later step. For now we just expose the values so the UI can show
// a balance and the groundwork is in place.
//
// Server-only — never import from a client component.

import "server-only";
import { db, pgConfigured } from "@/lib/db";

export interface UserProfile {
  id: string;
  plan: string;                  // 'free' | 'pro' | …
  credits: number;               // residual credits this cycle
  monthlyCredits: number;        // refill amount / cap (the "tetto")
  creditsPeriodStart: number | null;
  subscriptionStatus: string | null;  // 'active' | 'canceled' | …
  subscriptionPeriodEnd: number | null;
  stripeCustomerId: string | null;
  /** Epoch ms when the user completed (or explicitly skipped) the onboarding
   *  tour. null/undefined means the tour should be auto-triggered on next
   *  load. We stamp it server-side so it persists across devices. */
  onboardedAt: number | null;
}

export interface CreditTransaction {
  id: number;
  operation: string;
  amount: number;
  balanceAfter: number;
  metadata: Record<string, unknown>;
  createdAt: number;
}

interface ProfileRow {
  id: string;
  plan: string | null;
  credits: number | null;
  monthly_credits: number | null;
  credits_period_start: string | number | null;
  subscription_status: string | null;
  subscription_period_end: string | number | null;
  stripe_customer_id: string | null;
  onboarded_at: string | number | null;
}

function rowToProfile(r: ProfileRow): UserProfile {
  return {
    id: r.id,
    plan: r.plan ?? "free",
    credits: r.credits ?? 0,
    monthlyCredits: r.monthly_credits ?? 0,
    creditsPeriodStart: r.credits_period_start != null ? Number(r.credits_period_start) : null,
    subscriptionStatus: r.subscription_status ?? null,
    subscriptionPeriodEnd: r.subscription_period_end != null ? Number(r.subscription_period_end) : null,
    stripeCustomerId: r.stripe_customer_id,
    onboardedAt: r.onboarded_at != null ? Number(r.onboarded_at) : null,
  };
}

// Returns the profile, or null when Postgres isn't configured (pre-cutover) or
// the user row doesn't exist. Callers treat null as "billing not active" and
// behave exactly as the app did before this foundation landed.
export async function getUserProfile(id: string): Promise<UserProfile | null> {
  if (!id || !pgConfigured()) return null;
  const client = await db();
  const uid = id.trim().toLowerCase();
  const rows = (await client`
    SELECT id, plan, credits, monthly_credits, credits_period_start,
           subscription_status, subscription_period_end, stripe_customer_id, onboarded_at
    FROM users WHERE id = ${uid}
  `) as ProfileRow[];
  return rows[0] ? rowToProfile(rows[0]) : null;
}

/**
 * Persist the user's Stripe Customer ID. Called the first time we open a
 * checkout / portal session for them so subsequent calls reuse the same
 * Customer and don't fork their billing history into multiple customers.
 */
export async function setStripeCustomerId(userId: string, customerId: string): Promise<void> {
  if (!userId || !pgConfigured()) return;
  const client = await db();
  const uid = userId.trim().toLowerCase();
  await client`UPDATE users SET stripe_customer_id = ${customerId} WHERE id = ${uid}`;
}

/**
 * Look up an internal user by Stripe Customer ID. Used by the webhook to map
 * incoming Stripe events back to the user whose subscription changed.
 */
export async function getUserByStripeCustomerId(customerId: string): Promise<UserProfile | null> {
  if (!customerId || !pgConfigured()) return null;
  const client = await db();
  const rows = (await client`
    SELECT id, plan, credits, monthly_credits, credits_period_start,
           subscription_status, subscription_period_end, stripe_customer_id, onboarded_at
    FROM users WHERE stripe_customer_id = ${customerId}
  `) as ProfileRow[];
  return rows[0] ? rowToProfile(rows[0]) : null;
}

/** Read the most recent N credit transactions for a user — drives the
 *  /account page's "Cronologia crediti" panel. */
export async function listCreditTransactions(
  userId: string,
  limit = 25
): Promise<CreditTransaction[]> {
  if (!userId || !pgConfigured()) return [];
  const client = await db();
  const uid = userId.trim().toLowerCase();
  const rows = (await client`
    SELECT id, operation, amount, balance_after, metadata, created_at
    FROM credit_transactions
    WHERE user_id = ${uid}
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit}
  `) as Array<{
    id: number | string;
    operation: string;
    amount: number;
    balance_after: number;
    metadata: Record<string, unknown> | string | null;
    created_at: string | number;
  }>;
  return rows.map((r) => {
    let metadata: Record<string, unknown> = {};
    if (r.metadata && typeof r.metadata === "object") metadata = r.metadata as Record<string, unknown>;
    else if (typeof r.metadata === "string") {
      try { metadata = JSON.parse(r.metadata); } catch {}
    }
    return {
      id: Number(r.id),
      operation: r.operation,
      amount: r.amount,
      balanceAfter: r.balance_after,
      metadata,
      createdAt: Number(r.created_at),
    };
  });
}

/**
 * Mark the user's onboarding tour as complete (or reset it for a re-play).
 * Passing `null` un-stamps it so the tour auto-triggers on next mount —
 * used by the "Rifai il tour" button on /account.
 */
export async function setOnboardedAt(userId: string, ms: number | null): Promise<void> {
  if (!userId || !pgConfigured()) return;
  const client = await db();
  const uid = userId.trim().toLowerCase();
  await client`UPDATE users SET onboarded_at = ${ms} WHERE id = ${uid}`;
}

/**
 * Hard-delete a user and everything they own. Used by the "Cancella account"
 * action on /account. The delete is best-effort cross-table (Postgres only),
 * with the credentials row going last so a partial failure leaves the
 * account technically still-loginable rather than orphaning their data.
 * No-op when PG isn't configured.
 */
export async function deleteUserAndData(userId: string): Promise<void> {
  if (!userId || !pgConfigured()) return;
  const client = await db();
  const uid = userId.trim().toLowerCase();
  // Wrap the deletes in a single neon transaction so a failure halfway
  // through doesn't leave a half-deleted account.
  await client.transaction([
    client`DELETE FROM credit_transactions WHERE user_id = ${uid}`,
    client`DELETE FROM notes WHERE user_id = ${uid}`,
    client`DELETE FROM users WHERE id = ${uid}`,
  ]);
}
