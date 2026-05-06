// /api/auth/google — kicks off the Google OAuth code flow.
//
// Flow:
//   1. Generate a random `state` string (CSRF token).
//   2. Stash it in a short-lived httpOnly cookie. The callback verifies that
//      the cookie value matches the `state` Google echoes back, so an
//      attacker can't stitch together a malicious authorization request +
//      victim's logged-in session.
//   3. Redirect the browser to Google's authorization endpoint.
//
// We hand-roll the OAuth dance instead of pulling in NextAuth — the latter
// is a heavy dep for a single-provider, cookie-only sign-in flow on a
// codebase that already has its own JWT + cookie story.

import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 5 minutes is enough time for a normal Google authorization round-trip
// (user clicks button → Google → back) without leaving a stale CSRF token
// hanging around for a long time.
const STATE_COOKIE = "nota-oauth-state";
const STATE_MAX_AGE = 5 * 60;

function origin(req: NextRequest): string {
  // Prefer x-forwarded-* (Vercel sets these correctly behind its edge) over
  // req.url, which can be the internal proxy address in some runtimes.
  const proto = req.headers.get("x-forwarded-proto") || "https";
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
  if (host) return `${proto}://${host}`;
  return new URL(req.url).origin;
}

function randomState(): string {
  // 24 bytes of CSPRNG → ~32 base64url chars. Plenty of entropy.
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function GET(req: NextRequest) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json(
      { error: "Google OAuth non configurato (manca GOOGLE_CLIENT_ID)." },
      { status: 500 }
    );
  }

  const state = randomState();
  const redirectUri =
    process.env.GOOGLE_REDIRECT_URI || `${origin(req)}/api/auth/google/callback`;

  // Build Google's authorization URL. `prompt=select_account` lets the user
  // pick which Google account to use even if they're already logged into
  // one in the browser — important for shared computers.
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account",
    access_type: "online",
  });
  const authorizationUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

  const res = NextResponse.redirect(authorizationUrl);
  res.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: STATE_MAX_AGE,
  });
  return res;
}
