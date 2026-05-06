import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { getCredential } from "@/lib/credential-store";
import { createSessionToken, SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Naive in-memory rate limit (per Vercel function instance — best effort).
// For full protection use Vercel KV-backed limiting, but this is enough to
// blunt obvious brute-force attempts.
const ATTEMPTS = new Map<string, { count: number; resetAt: number }>();
const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 8;

function clientKey(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

function rateLimited(key: string): boolean {
  const now = Date.now();
  const entry = ATTEMPTS.get(key);
  if (!entry || entry.resetAt < now) {
    ATTEMPTS.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_ATTEMPTS;
}

// Pre-computed hash of an arbitrary value, used as a constant-time decoy when
// the email doesn't exist. Without this, the response time would leak
// whether an account is registered.
const DECOY_HASH = "$2b$12$KIXG3p3oU8YlXxbg4TlAg.4n5cHhAdgkoYjgxghPq7bV1tT0M/0ru";

export async function POST(req: NextRequest) {
  try {
    const ip = clientKey(req);
    if (rateLimited(ip)) {
      return NextResponse.json(
        { error: "Troppi tentativi. Riprova tra un minuto." },
        { status: 429 }
      );
    }

    const body = (await req.json().catch(() => ({}))) as {
      email?: unknown;
      // `username` is accepted as a fallback so legacy accounts created
      // before the email migration can still sign in.
      username?: unknown;
      password?: unknown;
    };
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const usernameFallback =
      typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
    const handle = email || usernameFallback;
    const password = typeof body.password === "string" ? body.password : "";

    const cred = handle ? await getCredential(handle) : null;
    // Always run bcrypt.compare — against the decoy hash if the email
    // doesn't exist — to keep response time roughly constant. Same defence
    // against username enumeration the previous route used.
    const passwordOk = await bcrypt.compare(
      password,
      cred?.passwordHash || DECOY_HASH
    );

    if (!cred || !cred.passwordHash || !passwordOk) {
      return NextResponse.json(
        { error: "Credenziali non valide." },
        { status: 401 }
      );
    }

    // Reset rate limit on successful login.
    ATTEMPTS.delete(ip);

    const token = await createSessionToken(cred.username);
    const res = NextResponse.json({
      ok: true,
      username: cred.username,
      email: cred.email,
      firstName: cred.firstName,
      lastName: cred.lastName,
    });
    res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
    return res;
  } catch (err) {
    console.error("Login error:", err);
    return NextResponse.json({ error: "Errore di login." }, { status: 500 });
  }
}
