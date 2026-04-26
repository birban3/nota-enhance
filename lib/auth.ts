// Session layer — signed JWT in an HttpOnly cookie.
// Edge-runtime safe (middleware uses jose only, no Node APIs).

import { SignJWT, jwtVerify } from "jose";

export const SESSION_COOKIE = "nota-session";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

function getKey(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 16) {
    // Dev fallback so local startup doesn't crash before .env.local is set.
    // In production we hard-fail loudly to refuse insecure deploys.
    if (process.env.NODE_ENV === "production") {
      throw new Error("AUTH_SECRET non configurata o troppo corta (min 16 char).");
    }
    return new TextEncoder().encode(
      "dev-only-not-for-production-please-set-AUTH_SECRET-1234567890"
    );
  }
  return new TextEncoder().encode(secret);
}

export interface SessionPayload {
  u: string;          // username
  iat?: number;
  exp?: number;
}

export async function createSessionToken(username: string): Promise<string> {
  return await new SignJWT({ u: username })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(getKey());
}

export async function verifySessionToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, getKey());
    const username = (payload as unknown as SessionPayload).u;
    return typeof username === "string" && username.length > 0 ? username : null;
  } catch {
    return null;
  }
}

export function sessionCookieOptions(): {
  httpOnly: true;
  secure: boolean;
  sameSite: "lax";
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE,
  };
}
