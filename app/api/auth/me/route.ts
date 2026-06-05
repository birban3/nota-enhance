import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken, SESSION_COOKIE } from "@/lib/auth";
import { getCredential } from "@/lib/credential-store";
import { applyMonthlyReset, getBillingSnapshot } from "@/lib/billing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const username = token ? await verifySessionToken(token) : null;
  if (!username) {
    return NextResponse.json({ authenticated: false, username: null });
  }
  // Lazy monthly reset: if 30+ days have elapsed since the user's last
  // credit replenishment, this top-ups their balance to the plan's
  // monthly_credits before we return. Cheap no-op for users still inside
  // the current period, and for setups without Postgres.
  await applyMonthlyReset(username);

  // Look up the full record so the app can render "Ciao Marco" without
  // every page having to re-fetch the credential separately. Billing snapshot
  // is null until Postgres is provisioned — the client treats that as
  // "billing not active" and skips the credits chip.
  const [cred, billing] = await Promise.all([
    getCredential(username),
    getBillingSnapshot(username),
  ]);
  return NextResponse.json({
    authenticated: true,
    username,
    email: cred?.email ?? null,
    firstName: cred?.firstName ?? null,
    lastName: cred?.lastName ?? null,
    plan: billing?.plan.id ?? null,
    planName: billing?.plan.displayName ?? null,
    credits: billing?.credits ?? null,
    monthlyCredits: billing?.monthlyCredits ?? null,
    creditsPeriodStart: billing?.creditsPeriodStart ?? null,
  });
}
