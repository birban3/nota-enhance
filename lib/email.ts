// Outbound transactional email — Resend, default-sender mode.
//
// Why this shape:
//   • Resend's free tier (no card at signup) lets you send from the shared
//     sender `onboarding@resend.dev` with ZERO DNS / domain verification.
//     The only setup is creating an API key and pasting it into
//     RESEND_API_KEY on Vercel — no SPF/DKIM, no records, no mailbox.
//   • Every suggestion is sent FROM that single shared address TO the fixed
//     inbox, exactly as requested.
//
// `mail()` degrades gracefully when RESEND_API_KEY is unset: it logs and
// returns ok:false. Callers MUST NOT block on it — persisting the
// suggestion is the user-visible promise; the email is a side notification.
//
// Server-only.

import "server-only";
import { Resend } from "resend";

// Resend's shared sandbox sender — works with no domain verification.
const DEFAULT_FROM = "nota/enhance <onboarding@resend.dev>";

export function emailConfigured(): boolean {
  return !!process.env.RESEND_API_KEY;
}

let _client: Resend | null = null;
function client(): Resend {
  if (_client) return _client;
  const k = process.env.RESEND_API_KEY;
  if (!k) throw new Error("RESEND_API_KEY non configurata.");
  _client = new Resend(k);
  return _client;
}

interface MailArgs {
  to: string;
  subject: string;
  html: string;
  /** Plain-text fallback. Auto-derived from html when omitted. */
  text?: string;
  /** Reply-To so a reply to the notification reaches the suggester (when
   *  they left a contact). */
  replyTo?: string;
}

export interface MailResult {
  ok: boolean;
  reason?: "not_configured" | "send_failed" | "missing_to";
  id?: string;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

export async function mail(args: MailArgs): Promise<MailResult> {
  if (!emailConfigured()) {
    console.warn("mail(): RESEND_API_KEY not set — email not sent");
    return { ok: false, reason: "not_configured" };
  }
  if (!args.to) return { ok: false, reason: "missing_to" };
  try {
    const r = await client().emails.send({
      from: DEFAULT_FROM,
      to: args.to,
      subject: args.subject,
      html: args.html,
      text: args.text ?? stripTags(args.html),
      ...(args.replyTo ? { replyTo: args.replyTo } : {}),
    });
    if (r.error) {
      console.warn("mail(): resend error:", r.error);
      return { ok: false, reason: "send_failed" };
    }
    return { ok: true, id: r.data?.id };
  } catch (err) {
    console.warn("mail(): send threw:", err);
    return { ok: false, reason: "send_failed" };
  }
}
