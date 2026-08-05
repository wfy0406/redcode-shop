import "dotenv/config";
import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";

// ── Password hashing (node:crypto scrypt) ──────────────────────
// Format: "<saltHex>:<hashHex>"

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, expectedHex] = stored.split(":");
  if (!salt || !expectedHex) return false;
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHex, "hex");
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

// ── JWT (jose, HS256) ──────────────────────────────────────────

export type AuthUser = {
  userId: number;
  role: "member" | "staff" | "admin";
};

function jwtSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not set");
  return new TextEncoder().encode(secret);
}

export async function signToken(user: AuthUser): Promise<string> {
  return new SignJWT({ role: user.role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(String(user.userId))
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(jwtSecret());
}

export async function verifyToken(token: string): Promise<AuthUser | null> {
  try {
    const { payload } = await jwtVerify(token, jwtSecret());
    const userId = Number(payload.sub);
    const role = payload.role as AuthUser["role"];
    if (!Number.isInteger(userId) || !["member", "staff", "admin"].includes(role)) {
      return null;
    }
    return { userId, role };
  } catch {
    return null;
  }
}

/** Extract and verify a Bearer token from an Authorization header value. */
export async function userFromAuthHeader(
  header: string | null | undefined,
): Promise<AuthUser | null> {
  if (!header) return null;
  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return null;
  return verifyToken(token);
}
