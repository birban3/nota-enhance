// /api/templates — per-user enhancement-instruction templates.
//
//   GET → { templates, defaults }  (custom + built-in defaults)
//   PUT → replace the custom list; body { templates: EnhanceTemplate[] }
//
// Auth required. Defaults are returned for the client to render but are not
// persisted (they're constant). When Postgres isn't configured, GET returns
// empty custom + defaults and PUT is a no-op echo — the client keeps custom
// templates in localStorage in that case.

import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken, SESSION_COOKIE } from "@/lib/auth";
import {
  getUserTemplates,
  saveUserTemplates,
  DEFAULT_TEMPLATES,
} from "@/lib/templates";
import { pgConfigured } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function user(req: NextRequest): Promise<string | null> {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  return token ? verifySessionToken(token) : null;
}

export async function GET(req: NextRequest) {
  const u = await user(req);
  if (!u) return NextResponse.json({ error: "Non autenticato." }, { status: 401 });
  const templates = await getUserTemplates(u);
  return NextResponse.json({ templates, defaults: DEFAULT_TEMPLATES, persisted: pgConfigured() });
}

export async function PUT(req: NextRequest) {
  const u = await user(req);
  if (!u) return NextResponse.json({ error: "Non autenticato." }, { status: 401 });
  let body: { templates?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const saved = await saveUserTemplates(u, body.templates);
  return NextResponse.json({ templates: saved, persisted: pgConfigured() });
}
