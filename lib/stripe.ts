// Stripe client + thin wrappers.
//
// Everything billable in the app reads from the DB (plans.stripe_price_id,
// users.stripe_customer_id), so there are no hardcoded prices or product
// names in code. The operator's responsibility, once Stripe is set up, is
// just to:
//   1. Create Products / Prices in the Stripe dashboard
//   2. Paste the price IDs into the plans table:
//        UPDATE plans SET stripe_price_id = 'price_abc' WHERE id = 'pro';
//   3. Configure the webhook endpoint + grab the signing secret
//
// When STRIPE_SECRET_KEY isn't set, `stripeConfigured()` returns false and
// every entry point here either returns null or throws a clear error — the
// rest of the app degrades to "no paid upgrades" mode (free plan + credits
// still work, just no upgrade path). That lets dev/preview run without a
// Stripe account.
//
// Server-only.

import "server-only";
import Stripe from "stripe";

export function stripeConfigured(): boolean {
  return !!process.env.STRIPE_SECRET_KEY;
}

// Lazy singleton — instantiating the Stripe client is cheap but we don't want
// to re-parse the secret on every request.
let _stripe: Stripe | null = null;

export function stripe(): Stripe {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("Stripe non configurato (manca STRIPE_SECRET_KEY).");
  // Pin the API version so a Stripe-side bump doesn't silently change
  // payload shapes under us. Tied to a recent version at time of writing.
  // The SDK accepts any string here at runtime; we pin a recent literal so
  // a Stripe-side bump doesn't silently change payload shapes under us. The
  // ctor's `apiVersion` is typed as a moving-target literal union that
  // shifts with every Stripe SDK release, so we widen via `unknown` rather
  // than chase a specific config type that may not even be exported.
  _stripe = new Stripe(key, {
    apiVersion: "2025-09-30.clover",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as unknown as any);
  return _stripe;
}

/** Find or create a Stripe Customer for the given internal user. Returns the
 *  Stripe customer id; the caller persists it to users.stripe_customer_id. */
export async function ensureStripeCustomer(
  userId: string,
  email?: string | null,
  name?: string | null,
  existingCustomerId?: string | null
): Promise<string> {
  // Trust the stored id if we have one — saves a round-trip per checkout.
  if (existingCustomerId) return existingCustomerId;
  const s = stripe();
  const customer = await s.customers.create({
    email: email ?? undefined,
    name: name ?? undefined,
    // Stripe's metadata is the canonical place to stash our user handle so
    // webhooks can map a Customer back to our row even if email changes.
    metadata: { app_user_id: userId },
  });
  return customer.id;
}
