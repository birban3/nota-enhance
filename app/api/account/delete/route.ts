// POST /api/account/delete
//
// Hard-delete the authenticated user and everything they own (notes,
// transactions). For Stripe-paying users we also cancel any active
// subscription so they don't keep being charged.
//
// The session cookie is cleared as part of the response so the next
// request from this browser is treated as logged out.

import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken, SESSION_COOKIE } from "@/lib/auth";
import { deleteUserAndData, getUserProfile } from "@/lib/users";
import { stripe, stripeConfigured } from "@/lib/stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const username = token ? await verifySessionToken(token) : null;
  if (!username) {
    return NextResponse.json({ error: "Non autenticato." }, { status: 401 });
  }

  // If they're on a paid subscription, cancel it Stripe-side first so the
  // next renewal doesn't charge a deleted user. Best-effort: a Stripe outage
  // shouldn't block the local delete (the operator can clean up orphan
  // subscriptions from the Stripe dashboard later).
  if (stripeConfigured()) {
    try {
      const profile = await getUserProfile(username);
      if (profile?.stripeCustomerId) {
        const s = stripe();
        const subs = await s.subscriptions.list({
          customer: profile.stripeCustomerId,
          status: "active",
          limit: 10,
        });
        for (const sub of subs.data) {
          await s.subscriptions.cancel(sub.id);
        }
      }
    } catch (err) {
      console.warn("Stripe subscription cleanup on delete failed:", err);
    }
  }

  await deleteUserAndData(username);

  // Expire the session cookie immediately so the next request from this
  // browser doesn't try to load /api/auth/me on a dead user.
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return res;
}
