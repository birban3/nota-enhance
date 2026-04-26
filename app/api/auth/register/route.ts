import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { getCredential, setCredential } from "@/lib/credential-store";
import { createSessionToken, SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth";

// Node runtime: bcryptjs is too slow on edge.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    // First-user-wins. If a credential already exists, registration is closed
    // forever for this deployment.
    const existing = await getCredential();
    if (existing) {
      return NextResponse.json(
        { error: "Account già esistente per questa istanza. Usa il login." },
        { status: 409 }
      );
    }

    const body = (await req.json().catch(() => ({}))) as {
      username?: unknown;
      password?: unknown;
    };
    const username =
      typeof body.username === "string" ? body.username.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";

    if (username.length < 3 || username.length > 64) {
      return NextResponse.json(
        { error: "Lo username deve avere tra 3 e 64 caratteri." },
        { status: 400 }
      );
    }
    if (password.length < 8) {
      return NextResponse.json(
        { error: "La password deve avere almeno 8 caratteri." },
        { status: 400 }
      );
    }

    const passwordHash = await bcrypt.hash(password, 12);
    await setCredential({
      username,
      passwordHash,
      createdAt: Date.now(),
    });

    const token = await createSessionToken(username);
    const res = NextResponse.json({ ok: true, username });
    res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
    return res;
  } catch (err) {
    console.error("Register error:", err);
    return NextResponse.json(
      { error: "Errore di registrazione." },
      { status: 500 }
    );
  }
}
