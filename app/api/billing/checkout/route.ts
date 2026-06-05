// POST /api/billing/checkout
//
// Opens a Stripe Checkout session for the authenticated user, returning the
// hosted Checkout URL the client should redirect to. The request body is
// `{ planId }` — the route looks the plan's Stripe price id up in the DB and
// uses it. No price ids are hardcoded in code; the operator changes pricing
// by editing the `plans` table.
//
// 400 — plan not found / no Stripe price id configured for it
// 401 — not authenticated
// 503 — STRIPE_SECRET_KEY not set (degraded mode)

import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken, SESSION_COOKIE } from "@/lib/auth";
import { getCredential } from "@/lib/credential-store";
import { getPlan } from "@/lib/billing";
import { getUserProfile, setStripeCustomerId } from "@/lib/users";
import { ensureStripeCustomer, stripe, stripeConfigured } from "@/lib/stripe";

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

  const body = (await req.json().catch(() => ({}))) as { planId?: unknown };
  const planId = typeof body.planId === "string" ? body.planId : "";
  if (!planId) {
    return NextResponse.json({ error: "planId mancante." }, { status: 400 });
  }

  const plan = await getPlan(planId);
  if (!plan) {
    return NextResponse.json({ error: "Piano non trovato." }, { status: 400 });
  }
  if (!plan.stripePriceId) {
    return NextResponse.json(
      {
        error:
          "Stripe price id non configurato per questo piano. Imposta `plans.stripe_price_id` per attivare il checkout.",
      },
      { status: 400 }
    );
  }

  // Reuse the user's Stripe Customer across sessions so billing history,
  // payment methods, and the customer portal stay coherent.
  const [profile, cred] = await Promise.all([
    getUserProfile(username),
    getCredential(username),
  ]);
  const customerId = await ensureStripeCustomer(
    username,
    cred?.email ?? null,
    [cred?.firstName, cred?.lastName].filter(Boolean).join(" ").trim() || null,
    profile?.stripeCustomerId ?? null
  );
  if (profile?.stripeCustomerId !== customerId) {
    await setStripeCustomerId(username, customerId);
  }

  const origin = originOf(req);
  const s = stripe();
  const session = await s.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: plan.stripePriceId, quantity: 1 }],
    // After payment, send the user back to /account with a query param so
    // the page can show a success toast.
    success_url: `${origin}/account?checkout=success`,
    cancel_url: `${origin}/account?checkout=cancel`,
    // Restate the app user id in metadata so the webhook can correlate even
    // if Stripe changes the customer's metadata format in the future.
    metadata: { app_user_id: username, plan_id: plan.id },
    subscription_data: { metadata: { app_user_id: username, plan_id: plan.id } },
  });

  if (!session.url) {
    return NextResponse.json({ error: "Stripe non ha restituito un URL checkout." }, { status: 500 });
  }
  return NextResponse.json({ url: session.url });
}
