import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { getCredential } from "@/lib/credential-store";
import { createSessionToken, SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Naive in-memory rate limit (per Vercel function instance — best effort).
// For full protection use Vercel KV-backed limiting, but this is enough to
// blunt obvious brute-force attempts on a single-user app.
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

export async function POST(req: NextRequest) {
  try {
    const ip = clientKey(req);
    if (rateLimited(ip)) {
      return NextResponse.json(
        { error: "Troppi tentativi. Riprova tra un minuto." },
        { status: 429 }
      );
    }

    const cred = await getCredential();
    if (!cred) {
      return NextResponse.json(
        { error: "Nessun account configurato. Esegui la registrazione iniziale.", needsRegister: true },
        { status: 404 }
      );
    }

    const body = (await req.json().catch(() => ({}))) as {
      username?: unknown;
      password?: unknown;
    };
    const username =
      typeof body.username === "string" ? body.username.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";

    // Always run bcrypt.compare even if usernames don't match — this keeps
    // the response time roughly constant and avoids username enumeration.
    const usernameOk = username === cred.username;
    const passwordOk = await bcrypt.compare(password, cred.passwordHash);

    if (!usernameOk || !passwordOk) {
      return NextResponse.json(
        { error: "Credenziali non valide." },
        { status: 401 }
      );
    }

    // Reset rate limit on successful login.
    ATTEMPTS.delete(ip);

    const token = await createSessionToken(cred.username);
    const res = NextResponse.json({ ok: true, username: cred.username });
    res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
    return res;
  } catch (err) {
    console.error("Login error:", err);
    return NextResponse.json({ error: "Errore di login." }, { status: 500 });
  }
}
