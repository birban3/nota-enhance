import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken, SESSION_COOKIE } from "@/lib/auth";
import { getCredential } from "@/lib/credential-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const username = token ? await verifySessionToken(token) : null;
  const cred = await getCredential();

  return NextResponse.json({
    authenticated: !!username,
    username: username || null,
    needsRegister: !cred,
  });
}
