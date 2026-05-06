import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken, SESSION_COOKIE } from "@/lib/auth";

// Edge runtime — only `jose` is used in this file. No Node APIs.

// Public marketing/auth surface — anyone can hit these without a session.
const PUBLIC_PATHS = [
  "/welcome",
  "/login",
  "/api/auth/login",
  "/api/auth/register",
  "/api/auth/me",
  "/api/auth/logout",
  // Google OAuth init + callback — visited by an unauthenticated browser
  // mid-flow, so they MUST be public. The callback handler enforces its
  // own state-cookie check before minting a session.
  "/api/auth/google",
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
  // get redirected to the public landing page. The landing page links to
  // /login for users who already have an account — we used to redirect
  // straight to /login, but with open registration we want first-time
  // visitors to see the marketing pitch first.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: "Non autenticato. Effettua il login." },
      { status: 401 }
    );
  }

  const url = req.nextUrl.clone();
  url.pathname = "/welcome";
  url.search = ""; // strip query so the landing is clean
  return NextResponse.redirect(url);
}

// Skip Next internals & static assets — middleware would only slow them
// down, and would also break PWA install flows: Safari/Chrome fetch
// /manifest.webmanifest, /icon.svg and /apple-icon during the "Add to
// Home Screen / Dock" handshake, sometimes without our session cookie
// (e.g. when the OS pre-caches them). Letting auth redirect those to
// /welcome produces a broken-icon tile on the home screen.
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|manifest.webmanifest|icon.svg|apple-icon).*)",
  ],
};
