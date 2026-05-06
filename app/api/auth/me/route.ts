import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken, SESSION_COOKIE } from "@/lib/auth";
import { getCredential } from "@/lib/credential-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const username = token ? await verifySessionToken(token) : null;
  if (!username) {
    return NextResponse.json({ authenticated: false, username: null });
  }
  // Look up the full record so the app can render "Ciao Marco" without
  // every page having to re-fetch the credential separately.
  const cred = await getCredential(username);
  return NextResponse.json({
    authenticated: true,
    username,
    email: cred?.email ?? null,
    firstName: cred?.firstName ?? null,
    lastName: cred?.lastName ?? null,
  });
}
