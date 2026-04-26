import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken, SESSION_COOKIE } from "@/lib/auth";

// Edge runtime — only `jose` is used in this file. No Node APIs.

const PUBLIC_PATHS = [
  "/login",
  "/api/auth/login",
  "/api/auth/register",
  "/api/auth/me",
  "/api/auth/logout",
];

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (isPublic(pathname)) return NextResponse.next();

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const username = token ? await verifySessionToken(token) : null;
  if (username) return NextResponse.next();

  // Unauthenticated. APIs get a clean 401 (so the client can react), pages
  // get redirected to /login.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: "Non autenticato. Effettua il login." },
      { status: 401 }
    );
  }

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = ""; // strip query so the form is clean
  return NextResponse.redirect(url);
}

// Skip Next internals & static assets — middleware would only slow them down.
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)",
  ],
};
