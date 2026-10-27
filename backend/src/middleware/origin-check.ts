import type { RequestHandler } from 'express';
import { AppError } from '../errors/app-error.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defense-in-depth for cookie auth (on top of SameSite=Lax): browsers always send an
 * Origin header on cross-site state-changing requests, so reject any that is not allow-listed.
 * Requests without Origin (curl, server-to-server, tests) are not browser CSRF vectors.
 */
export function createOriginCheck(allowedOrigins: string[]): RequestHandler {
  return (req, _res, next) => {
    const origin = req.headers.origin;
    if (!SAFE_METHODS.has(req.method) && origin !== undefined && !allowedOrigins.includes(origin)) {
      next(new AppError('FORBIDDEN', 403, 'Origin not allowed'));
      return;
    }
    next();
  };
}
