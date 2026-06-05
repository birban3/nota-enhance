// POST /api/billing/portal
//
// Opens the Stripe Customer Portal for the authenticated user. The portal
// is the Stripe-hosted page where they can update payment methods, see
// invoices, and cancel their subscription — we don't reimplement any of
// that ourselves.
//
// 400 — no Stripe customer associated with the user yet (they've never
//       checked out)
// 401 — not authenticated
// 503 — STRIPE_SECRET_KEY not set

import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken, SESSION_COOKIE } from "@/lib/auth";
import { getUserProfile } from "@/lib/users";
import { stripe, stripeConfigured } from "@/lib/stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function originOf(req: NextRequest): string {
  const proto = req.headers.get("x-forwarded-proto") || "https";
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
  if (host) return `${proto}://${host}`;
  return new URL(req.url).origin;
}

export async function POST(req: NextRequest) {
  if (!stripeConfigured()) {
    return NextResponse.json(
      { error: "Pagamenti non ancora attivi su questa istanza." },
      { status: 503 }
    );
  }
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const username = token ? await verifySessionToken(token) : null;
  if (!username) {
    return NextResponse.json({ error: "Non autenticato." }, { status: 401 });
  }
  const profile = await getUserProfile(username);
  if (!profile?.stripeCustomerId) {
    return NextResponse.json(
      { error: "Nessun abbonamento ancora attivo." },
      { status: 400 }
    );
  }
  const s = stripe();
  const session = await s.billingPortal.sessions.create({
    customer: profile.stripeCustomerId,
    return_url: `${originOf(req)}/account`,
  });
  return NextResponse.json({ url: session.url });
}
