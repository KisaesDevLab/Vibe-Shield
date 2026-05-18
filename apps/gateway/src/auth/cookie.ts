/**
 * Cookie helpers — Phase 24.
 *
 * Hand-rolled instead of pulling cookie-parser: the surface we need is
 * tiny (one cookie name, one parse, one set, one clear). Hand-rolling
 * also lets us be strict about attributes — HttpOnly + SameSite=Lax +
 * Path=/ are always set; Secure depends on NODE_ENV.
 */

import type { Request, Response } from 'express';

export const SESSION_COOKIE_NAME = 'vs_session';

export interface CookieOptions {
  /** True in production (HTTPS-only). */
  secure: boolean;
  /** Cookie expiry, absolute. */
  expires: Date;
}

export function setSessionCookie(
  res: Response,
  token: string,
  opts: CookieOptions,
): void {
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    `Expires=${opts.expires.toUTCString()}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (opts.secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function clearSessionCookie(res: Response, secure: boolean): void {
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

/**
 * Extract the session cookie from an incoming request. Returns
 * ``undefined`` when missing or malformed — never throws.
 */
export function readSessionCookie(req: Request): string | undefined {
  const header = req.header('cookie');
  if (header === undefined || header === '') return undefined;
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const name = trimmed.slice(0, eq);
    if (name !== SESSION_COOKIE_NAME) continue;
    const value = trimmed.slice(eq + 1);
    try {
      return decodeURIComponent(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}
