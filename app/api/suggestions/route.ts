// /api/suggestions — POST a new improvement suggestion.
//
// Auth required (we want to attribute suggestions to a username so spam can
// be triaged later). Middleware already enforces the JWT cookie before this
// handler runs, but we re-verify here as defence in depth.

import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken, SESSION_COOKIE } from "@/lib/auth";
import { appendSuggestion, type Suggestion } from "@/lib/suggestions-store";
import { mail } from "@/lib/email";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Fixed inbox that receives a notification email for every suggestion.
// Hardcoded by request — no per-deploy configuration needed.
const SUGGESTIONS_INBOX = "giorgiolongo194@gmail.com";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Per-instance, per-IP rate limit: avoid one user mashing submit and pushing
// older suggestions out of the cap. KV-backed limits would be more robust
// across function instances but this is enough for a beta.
const ATTEMPTS = new Map<string, { count: number; resetAt: number }>();
const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_PER_HOUR = 10;

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
  return entry.count > MAX_PER_HOUR;
}

const TEXT_MIN = 5;
const TEXT_MAX = 4000;
const CONTACT_MAX = 200;

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

export async function POST(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const username = token ? await verifySessionToken(token) : null;
  if (!username) {
    return NextResponse.json({ error: "Non autenticato." }, { status: 401 });
  }

  const ip = clientKey(req);
  if (rateLimited(ip)) {
    return NextResponse.json(
      { error: "Hai inviato troppi suggerimenti di recente. Riprova più tardi." },
      { status: 429 }
    );
  }

  let body: { text?: unknown; contact?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const text = typeof body.text === "string" ? body.text.trim() : "";
  const contact = typeof body.contact === "string" ? body.contact.trim() : "";
  if (text.length < TEXT_MIN) {
    return NextResponse.json(
      { error: `Suggerimento troppo corto (min ${TEXT_MIN} caratteri).` },
      { status: 400 }
    );
  }
  if (text.length > TEXT_MAX) {
    return NextResponse.json(
      { error: `Suggerimento troppo lungo (max ${TEXT_MAX} caratteri).` },
      { status: 400 }
    );
  }
  if (contact.length > CONTACT_MAX) {
    return NextResponse.json(
      { error: `Campo contatto troppo lungo (max ${CONTACT_MAX} caratteri).` },
      { status: 400 }
    );
  }

  const entry: Suggestion = {
    id: uid(),
    username,
    text,
    createdAt: Date.now(),
    ...(contact ? { contact } : {}),
  };

  try {
    await appendSuggestion(entry);
  } catch (err) {
    console.error("suggestions POST failed:", err);
    return NextResponse.json(
      { error: "Salvataggio del suggerimento fallito." },
      { status: 500 }
    );
  }

  // Fire the notification email AFTER the suggestion is safely stored.
  // Best-effort: the suggestion is already persisted, so an email failure
  // (RESEND_API_KEY missing, provider down) must not turn into a user-facing
  // error. We await it so it actually runs within the serverless invocation
  // (a dangling promise could be killed when the function returns), but we
  // swallow the result.
  try {
    const when = new Date(entry.createdAt).toLocaleString("it-IT", {
      day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit",
    });
    const contactLine = entry.contact
      ? `<p><strong>Contatto:</strong> ${esc(entry.contact)}</p>`
      : `<p><strong>Contatto:</strong> <em>non lasciato</em></p>`;
    await mail({
      to: SUGGESTIONS_INBOX,
      subject: `Nuovo suggerimento da ${entry.username}`,
      // If the user left an email-looking contact, make Reply go to them.
      replyTo: entry.contact && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(entry.contact)
        ? entry.contact
        : undefined,
      html: `
        <div style="font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; font-size:14px; color:#1c1917; line-height:1.5;">
          <h2 style="margin:0 0 4px;">Nuovo suggerimento</h2>
          <p style="color:#78716c; margin:0 0 16px; font-size:12px;">${esc(when)}</p>
          <p><strong>Utente:</strong> ${esc(entry.username)}</p>
          ${contactLine}
          <p style="margin-top:16px;"><strong>Suggerimento:</strong></p>
          <div style="white-space:pre-wrap; background:#f5f5f4; border:1px solid #e7e5e4; border-radius:8px; padding:12px;">${esc(entry.text)}</div>
        </div>
      `,
    });
  } catch (err) {
    console.warn("suggestion notification email failed (non-fatal):", err);
  }

  return NextResponse.json({ ok: true });
}
