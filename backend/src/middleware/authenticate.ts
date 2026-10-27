import type { RequestHandler } from 'express';
import { readCookie, type CookieNames } from '../auth/auth-cookies.js';
import { verifyAccessToken } from '../auth/access-token.js';
import { resolveSession } from '../auth/session.service.js';
import { AppError } from '../errors/app-error.js';
import type { PrismaClient } from '../generated/prisma/client.js';

/**
 * Requires the HttpOnly access-token cookie (ADR 0019); attaches the user to `req.auth`.
 *
 * A user whose password an admin reset (`mustChangePassword`) is refused with 403
 * PASSWORD_CHANGE_REQUIRED on every route unless it opts in with `allowPasswordChangeRequired`
 * (only /auth/me and /auth/change-password do). Deny-by-default: a new route is protected
 * without anyone remembering to add a check.
 */
export function createAuthenticate(
  prisma: PrismaClient,
  options: { allowPasswordChangeRequired?: boolean } = {},
): RequestHandler {
  return async (req, _res, next) => {
    const unauthenticated = () => {
      next(new AppError('UNAUTHENTICATED', 401, 'Authentication required'));
    };

    const secret = req.app.locals['jwtSecret'] as string; // set once in createApp
    const names = req.app.locals['cookieNames'] as CookieNames; // set once in createApp
    const token = readCookie(req, names.access);
    const claims = token ? await verifyAccessToken(secret, token) : null;
    const user = claims ? await resolveSession(prisma, claims.sessionId, claims.userId) : null;
    if (!claims || !user) {
      unauthenticated();
      return;
    }
    if (user.mustChangePassword && !options.allowPasswordChangeRequired) {
      next(new AppError('PASSWORD_CHANGE_REQUIRED', 403, 'You must change your password first'));
      return;
    }
    req.auth = user;
    req.sessionId = claims.sessionId;
    next();
  };
}
