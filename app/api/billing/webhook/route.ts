// POST /api/billing/webhook
//
// Stripe calls this endpoint whenever subscription state changes. It's the
// canonical source of truth for "did the user actually pay?" — never trust
// the client's "yes I paid" claim, always wait for the webhook.
//
// Mapping (only the events that affect our local state):
//   checkout.session.completed       → first successful payment after a new
//                                      subscription, top up credits
//   customer.subscription.updated    → plan change, status change, renewal
//   customer.subscription.deleted    → subscription canceled → revert to free
//   invoice.paid                     → recurring renewal → top up credits
//   invoice.payment_failed           → mark subscription as past_due
//
// We resolve the local user via:
//   1. session.metadata.app_user_id     (we set it at checkout creation)
//   2. subscription.metadata.app_user_id
//   3. customers table lookup by stripe_customer_id (fallback)
// The triple lookup means a Stripe-side change to one of the paths still
// hits one of the others.
//
// IMPORTANT: this route MUST be public (no JWT cookie — Stripe doesn't have
// one). Signature verification is the auth mechanism; the
// STRIPE_WEBHOOK_SECRET acts as the shared secret.

import { NextRequest, NextResponse } from "next/server";
import type Stripe from "stripe";
import { stripe, stripeConfigured } from "@/lib/stripe";
import {
  activateSubscription,
  deactivateSubscription,
  getPlanByStripePriceId,
} from "@/lib/billing";
import { getUserByStripeCustomerId } from "@/lib/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Map a Stripe event to our local user id. Tries the three locations Stripe
// surfaces an id in (in order of reliability) and gives up if none match.
async function resolveUserId(event: Stripe.Event): Promise<string | null> {
  const data = event.data.object as
    | Stripe.Checkout.Session
    | Stripe.Subscription
    | Stripe.Invoice
    | { customer?: string | Stripe.Customer | null; metadata?: Record<string, string> | null };

  // 1. Inline metadata on the event object.
  const metaUser = (data as { metadata?: Record<string, string> | null }).metadata?.app_user_id;
  if (metaUser) return metaUser;

  // 2. For invoice / subscription events, peek at the subscription's metadata
  //    (we wrote app_user_id there at checkout creation).
  if (event.type.startsWith("invoice.")) {
    const subId = subscriptionIdFromInvoice(data as Stripe.Invoice);
    if (subId) {
      try {
        const sub = await stripe().subscriptions.retrieve(subId);
        const u = sub.metadata?.app_user_id;
        if (u) return u;
      } catch (err) {
        console.warn("webhook: failed to retrieve subscription for metadata lookup:", err);
      }
    }
  }

  // 3. Last resort: customer id → DB lookup. Slower (DB round-trip) but
  //    works even if metadata went missing.
  const cust = (data as { customer?: string | Stripe.Customer | null }).customer;
  const customerId = typeof cust === "string" ? cust : cust?.id ?? null;
  if (customerId) {
    const row = await getUserByStripeCustomerId(customerId);
    if (row) return row.id;
  }
  return null;
}

// Pull the first item's price id off a subscription so we can map it back to
// our `plans` row (which holds the credit allowance).
function priceIdFromSubscription(sub: Stripe.Subscription): string | null {
  const item = sub.items?.data?.[0];
  return item?.price?.id ?? null;
}

// The Invoice shape moved across Stripe SDK versions: pre-v22 had a flat
// `subscription` field; v22 puts it under `parent.subscription_details`. We
// probe both so this code survives a future Stripe SDK bump without a code
// change.
function subscriptionIdFromInvoice(inv: Stripe.Invoice): string | null {
  const probe = inv as unknown as {
    subscription?: string | { id?: string } | null;
    parent?: { subscription_details?: { subscription?: string | { id?: string } | null } | null } | null;
  };
  const direct = probe.subscription;
  if (typeof direct === "string") return direct;
  if (direct && typeof direct === "object" && "id" in direct && typeof direct.id === "string") {
    return direct.id;
  }
  const nested = probe.parent?.subscription_details?.subscription;
  if (typeof nested === "string") return nested;
  if (nested && typeof nested === "object" && "id" in nested && typeof nested.id === "string") {
    return nested.id;
  }
  return null;
}

async function handleSubscriptionState(
  sub: Stripe.Subscription,
  userId: string
): Promise<void> {
  const priceId = priceIdFromSubscription(sub);
  if (!priceId) {
    console.warn("webhook: subscription has no items[0].price.id", sub.id);
    return;
  }
  const plan = await getPlanByStripePriceId(priceId);
  if (!plan) {
    console.warn(`webhook: no plan row with stripe_price_id=${priceId}`);
    return;
  }
  // Stripe period_end is seconds; we store ms.
  const subObj = sub as Stripe.Subscription & { current_period_end?: number };
  const periodEndMs = subObj.current_period_end != null
    ? subObj.current_period_end * 1000
    : Date.now() + 30 * 24 * 60 * 60 * 1000; // sensible fallback

  // status "active" → activate. "canceled"/"unpaid"/"past_due" → degrade.
  if (sub.status === "active" || sub.status === "trialing") {
    await activateSubscription(userId, plan.id, sub.status, periodEndMs);
  } else if (sub.status === "canceled") {
    await deactivateSubscription(userId, "canceled");
  } else if (sub.status === "past_due" || sub.status === "unpaid") {
    await deactivateSubscription(userId, "payment_failed");
  }
}

export async function POST(req: NextRequest) {
  if (!stripeConfigured()) {
    // Webhook still configured server-side but secret missing → respond 200
    // so Stripe doesn't retry forever. (Configuring Stripe partially is on
    // the operator; we don't want runaway retries in the meantime.)
    return NextResponse.json({ ok: true, ignored: "stripe_not_configured" });
  }
  const signingSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!signingSecret) {
    console.error("webhook: STRIPE_WEBHOOK_SECRET not set — refusing to process events");
    return NextResponse.json({ error: "Webhook non configurato." }, { status: 503 });
  }

  // Stripe needs the RAW body for signature verification — we can't use
  // req.json() because it consumes the stream and reformats whitespace.
  const rawBody = await req.text();
  const sig = req.headers.get("stripe-signature");
  if (!sig) {
    return NextResponse.json({ error: "Firma mancante." }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = stripe().webhooks.constructEvent(rawBody, sig, signingSecret);
  } catch (err) {
    console.error("webhook: signature verification failed:", err);
    return NextResponse.json({ error: "Firma non valida." }, { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const userId = (await resolveUserId(event)) ?? null;
        if (!userId) {
          console.warn("webhook: checkout.session.completed without resolvable user");
          break;
        }
        // Retrieve the subscription to get the live price id + period end.
        if (session.subscription) {
          const subId =
            typeof session.subscription === "string" ? session.subscription : session.subscription.id;
          const sub = await stripe().subscriptions.retrieve(subId);
          await handleSubscriptionState(sub, userId);
        }
        break;
      }
      case "customer.subscription.updated":
      case "customer.subscription.created": {
        const sub = event.data.object as Stripe.Subscription;
        const userId = (await resolveUserId(event)) ?? null;
        if (!userId) break;
        await handleSubscriptionState(sub, userId);
        break;
      }
      case "customer.subscription.deleted": {
        const userId = (await resolveUserId(event)) ?? null;
        if (!userId) break;
        await deactivateSubscription(userId, "canceled");
        break;
      }
      case "invoice.paid": {
        // Subsequent renewal — re-run the activation path to top up credits
        // for the new cycle.
        const inv = event.data.object as Stripe.Invoice;
        const subId = subscriptionIdFromInvoice(inv);
        if (!subId) break;
        const userId = (await resolveUserId(event)) ?? null;
        if (!userId) break;
        const sub = await stripe().subscriptions.retrieve(subId);
        await handleSubscriptionState(sub, userId);
        break;
      }
      case "invoice.payment_failed": {
        const userId = (await resolveUserId(event)) ?? null;
        if (!userId) break;
        await deactivateSubscription(userId, "payment_failed");
        break;
      }
      // Everything else (customer.created, customer.updated, …) is fine to
      // accept silently — Stripe expects a 2xx so it stops retrying.
      default:
        break;
    }
  } catch (err) {
    // Log + 500 so Stripe retries. Idempotency on our side comes from the
    // activate/deactivate functions being safe to re-run.
    console.error("webhook handler threw for", event.type, ":", err);
    return NextResponse.json({ error: "Errore interno webhook." }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
