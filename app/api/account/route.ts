// GET /api/account
//
// Returns everything the /account page needs in one round-trip:
//   - user (firstName, lastName, email)
//   - profile (plan, credits, monthlyCredits, period start, subscription state)
//   - active plans (so the UI can render upgrade buttons for each)
//   - recent credit transactions (audit log for the "Cronologia" panel)

import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken, SESSION_COOKIE } from "@/lib/auth";
import { getCredential } from "@/lib/credential-store";
import { applyMonthlyReset, listActivePlans } from "@/lib/billing";
import { getUserProfile, listCreditTransactions } from "@/lib/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const username = token ? await verifySessionToken(token) : null;
  if (!username) {
    return NextResponse.json({ error: "Non autenticato." }, { status: 401 });
  }

  // Run the lazy monthly reset before reading so the balance the user sees
  // on the account page is the live one. Same pattern as /api/auth/me.
  await applyMonthlyReset(username);

  const [cred, profile, plans, transactions] = await Promise.all([
    getCredential(username),
    getUserProfile(username),
    listActivePlans(),
    listCreditTransactions(username, 25),
  ]);

  return NextResponse.json({
    user: {
      username,
      email: cred?.email ?? null,
      firstName: cred?.firstName ?? null,
      lastName: cred?.lastName ?? null,
      hasPassword: !!cred?.passwordHash,
      hasGoogle: !!cred?.googleSub,
    },
    profile: profile
      ? {
          plan: profile.plan,
          credits: profile.credits,
          monthlyCredits: profile.monthlyCredits,
          creditsPeriodStart: profile.creditsPeriodStart,
          subscriptionStatus: profile.subscriptionStatus,
          subscriptionPeriodEnd: profile.subscriptionPeriodEnd,
          hasStripeCustomer: !!profile.stripeCustomerId,
        }
      : null,
    plans: plans.map((p) => ({
      id: p.id,
      displayName: p.displayName,
      monthlyCredits: p.monthlyCredits,
      hasStripePrice: !!p.stripePriceId,
      position: p.position,
    })),
    transactions,
  });
}
