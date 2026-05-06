// /api/auth/google/callback — completes the Google OAuth code flow.
//
//   1. Verify state matches the cookie set by /api/auth/google.
//   2. Exchange the authorization code for tokens.
//   3. Fetch the user profile from Google's userinfo endpoint.
//   4. Find or create the local Credential, set our session JWT cookie,
//      redirect to /.

import { NextRequest, NextResponse } from "next/server";
import { getCredential, setCredential, type Credential } from "@/lib/credential-store";
import { createSessionToken, SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATE_COOKIE = "nota-oauth-state";

function origin(req: NextRequest): string {
  const proto = req.headers.get("x-forwarded-proto") || "https";
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
  if (host) return `${proto}://${host}`;
  return new URL(req.url).origin;
}

function errorRedirect(req: NextRequest, message: string): NextResponse {
  // Bounce back to /login with a query param the form can surface. We don't
  // pass the raw OAuth error code from Google — most of them are useless to
  // a Italian-speaking end user — and instead translate to a single short
  // message.
  const url = new URL("/login", origin(req));
  url.searchParams.set("oauth_error", message);
  const res = NextResponse.redirect(url);
  // Always clear the state cookie on the way out, success or failure.
  res.cookies.set(STATE_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}

interface TokenResponse {
  access_token?: string;
  id_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

interface UserInfo {
  sub?: string;
  email?: string;
  email_verified?: boolean;
  given_name?: string;
  family_name?: string;
  name?: string;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const stateFromQuery = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  if (oauthError) {
    return errorRedirect(req, "Accesso con Google annullato.");
  }
  if (!code || !stateFromQuery) {
    return errorRedirect(req, "Risposta OAuth incompleta.");
  }

  const stateCookie = req.cookies.get(STATE_COOKIE)?.value;
  if (!stateCookie || stateCookie !== stateFromQuery) {
    return errorRedirect(req, "Sessione OAuth scaduta. Riprova.");
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return errorRedirect(req, "Google OAuth non configurato sul server.");
  }
  const redirectUri =
    process.env.GOOGLE_REDIRECT_URI || `${origin(req)}/api/auth/google/callback`;

  // Step 1: trade the code for tokens.
  let tokens: TokenResponse;
  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }).toString(),
      cache: "no-store",
    });
    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      console.error("Google token exchange failed:", tokenRes.status, text);
      return errorRedirect(req, "Scambio token Google fallito.");
    }
    tokens = (await tokenRes.json()) as TokenResponse;
  } catch (err) {
    console.error("Google token exchange threw:", err);
    return errorRedirect(req, "Errore di rete con Google.");
  }

  if (!tokens.access_token) {
    return errorRedirect(req, "Token Google mancante.");
  }

  // Step 2: fetch the user profile.
  let userInfo: UserInfo;
  try {
    const userInfoRes = await fetch(
      "https://www.googleapis.com/oauth2/v3/userinfo",
      {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
        cache: "no-store",
      }
    );
    if (!userInfoRes.ok) {
      const text = await userInfoRes.text();
      console.error("Google userinfo failed:", userInfoRes.status, text);
      return errorRedirect(req, "Recupero profilo Google fallito.");
    }
    userInfo = (await userInfoRes.json()) as UserInfo;
  } catch (err) {
    console.error("Google userinfo threw:", err);
    return errorRedirect(req, "Errore di rete con Google.");
  }

  const email = userInfo.email?.trim().toLowerCase();
  if (!email || !userInfo.email_verified) {
    return errorRedirect(req, "Account Google senza email verificata.");
  }
  if (!userInfo.sub) {
    return errorRedirect(req, "Identificativo Google mancante.");
  }

  // Step 3: find or create the local credential. Email is the primary key,
  // so a Google sign-in for an email that already has a password account
  // logs the user into that account (and links the Google sub for next time).
  const existing = await getCredential(email);
  if (existing) {
    if (!existing.googleSub) {
      // Link this Google account on first use.
      const linked: Credential = { ...existing, googleSub: userInfo.sub };
      try { await setCredential(linked); } catch (err) {
        console.warn("Failed to link Google sub to existing user:", err);
      }
    }
  } else {
    const cred: Credential = {
      username: email,
      email,
      firstName: userInfo.given_name || "",
      lastName: userInfo.family_name || "",
      // No local password for Google-only accounts. The login route refuses
      // password attempts when this is empty.
      passwordHash: "",
      googleSub: userInfo.sub,
      createdAt: Date.now(),
    };
    try {
      await setCredential(cred);
    } catch (err) {
      console.error("Failed to create credential after Google login:", err);
      return errorRedirect(req, "Creazione account fallita.");
    }
  }

  // Step 4: mint our session and redirect to the app.
  const token = await createSessionToken(email);
  const res = NextResponse.redirect(new URL("/", origin(req)));
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
  res.cookies.set(STATE_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}
