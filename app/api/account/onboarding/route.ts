// POST /api/account/onboarding
//
// Two modes (driven by `?action=complete|reset`, default 'complete'):
//   complete → stamp users.onboarded_at with the current epoch ms. Idempotent
//              if it's already set.
//   reset    → clear users.onboarded_at, so the next page load re-triggers
//              the tour. Used by the "Rifai il tour" button on /account.
//
// 401 — not authenticated
// 200 + { persisted: false } — billing/profile storage (Postgres) not
//   configured. The client also drops a localStorage breadcrumb so the
//   tour still doesn't re-loop on this device.

import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken, SESSION_COOKIE } from "@/lib/auth";
import { setOnboardedAt } from "@/lib/users";
import { pgConfigured } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const username = token ? await verifySessionToken(token) : null;
  if (!username) {
    return NextResponse.json({ error: "Non autenticato." }, { status: 401 });
  }
  if (!pgConfigured()) {
    // Client falls back to localStorage. We respond 200 (not an error) so
    // the UI flow doesn't surface a scary message in a valid degraded
    // mode.
    return NextResponse.json({ ok: true, persisted: false });
  }
  const url = new URL(req.url);
  const action = url.searchParams.get("action") ?? "complete";
  if (action === "reset") {
    await setOnboardedAt(username, null);
    return NextResponse.json({ ok: true, persisted: true, onboardedAt: null });
  }
  const t = Date.now();
  await setOnboardedAt(username, t);
  return NextResponse.json({ ok: true, persisted: true, onboardedAt: t });
}
