import type { Request, Response } from 'express';
import type { Env } from '../config/env.js';

/**
 * The two HttpOnly cookies that carry the tokens (ADR 0019). JavaScript on the page can never read
 * them, so an XSS cannot copy a token away; the browser attaches them to same-origin API calls.
 *
 * - access (JWT, short-lived): `Path=/`. In production it is `__Host-at`, which browsers only accept
 *   when it is Secure, has `Path=/` and no `Domain`, so a sibling subdomain cannot plant ("toss") one.
 * - refresh (opaque, rotating): `Path=/api/auth`, so the browser sends it only to the auth endpoints
 *   instead of with every request. A `__Host-` cookie must use `Path=/`, hence `__Secure-` here.
 *
 * Over plain-HTTP local development neither prefix can be used (they require Secure), so the plain
 * names are used. `Secure` follows NODE_ENV, which defaults to production (fail-safe).
 */
export const REFRESH_COOKIE_PATH = '/api/auth';

export interface CookieNames {
  access: string;
  refresh: string;
}

export function cookieNames(nodeEnv: Env['NODE_ENV']): CookieNames {
  return nodeEnv === 'production'
    ? { access: '__Host-at', refresh: '__Secure-rt' }
    : { access: 'at', refresh: 'rt' };
}

export interface IssuedTokens {
  accessToken: string;
  /** Seconds until `accessToken` expires. */
  expiresIn: number;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

const baseOptions = (nodeEnv: Env['NODE_ENV']) =>
  ({ httpOnly: true, secure: nodeEnv === 'production', sameSite: 'lax' }) as const;

export function setAuthCookies(
  res: Response,
  nodeEnv: Env['NODE_ENV'],
  tokens: IssuedTokens,
): void {
  const names = cookieNames(nodeEnv);
  res.cookie(names.access, tokens.accessToken, {
    ...baseOptions(nodeEnv),
    path: '/',
    maxAge: tokens.expiresIn * 1000,
  });
  res.cookie(names.refresh, tokens.refreshToken, {
    ...baseOptions(nodeEnv),
    path: REFRESH_COOKIE_PATH,
    expires: tokens.refreshTokenExpiresAt,
  });
}

/** Expires both cookies. The attributes must match the ones used to set them. */
export function clearAuthCookies(res: Response, nodeEnv: Env['NODE_ENV']): void {
  const names = cookieNames(nodeEnv);
  res.clearCookie(names.access, { ...baseOptions(nodeEnv), path: '/' });
  res.clearCookie(names.refresh, { ...baseOptions(nodeEnv), path: REFRESH_COOKIE_PATH });
}

/** Reads one cookie as a non-empty string (cookie-parser leaves other shapes undefined). */
export function readCookie(req: Request, name: string): string | undefined {
  const value: unknown = req.cookies?.[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
