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
  subscriptionStatus: string | null;  // 'active' | 'canceled' | null
  subscriptionPeriodEnd: number | null;
}

interface ProfileRow {
  id: string;
  plan: string | null;
  credits: number | null;
  monthly_credits: number | null;
  credits_period_start: string | number | null;
  subscription_status: string | null;
  subscription_period_end: string | number | null;
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
           subscription_status, subscription_period_end
    FROM users WHERE id = ${uid}
  `) as ProfileRow[];
  return rows[0] ? rowToProfile(rows[0]) : null;
}
