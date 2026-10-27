import type { RequestHandler } from 'express';
import { clearAuthCookies, cookieNames, readCookie, setAuthCookies } from '../auth/auth-cookies.js';
import { AppError } from '../errors/app-error.js';
import type { Env } from '../config/env.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { getValidated } from '../middleware/validate.js';
import { requireAuth } from '../middleware/authorize.js';
import { login, logout, refresh, type TokenOptions } from '../services/auth.service.js';
import { changeOwnPassword } from '../services/user.service.js';
import type { changePasswordSchemas, loginSchemas } from '../validation/auth.schemas.js';

export function createAuthController(prisma: PrismaClient, env: Env) {
  const tokenOptions: TokenOptions = {
    jwtSecret: env.JWT_SECRET,
    accessTokenTtlMinutes: env.ACCESS_TOKEN_TTL_MINUTES,
    sessionTtlHours: env.SESSION_TTL_HOURS,
  };

  const names = cookieNames(env.NODE_ENV);

  // Tokens travel only in HttpOnly cookies, never in the JSON body (JS must not be able to read them).
  const postLogin: RequestHandler = async (_req, res) => {
    const { body } = getValidated<typeof loginSchemas>(res);
    const result = await login(prisma, body, tokenOptions);
    setAuthCookies(res, env.NODE_ENV, result);
    res.status(200).json({ user: result.user });
  };

  const postRefresh: RequestHandler = async (req, res) => {
    const refreshToken = readCookie(req, names.refresh);
    try {
      if (!refreshToken)
        throw new AppError('UNAUTHENTICATED', 401, 'Invalid or expired refresh token');
      const result = await refresh(prisma, refreshToken, tokenOptions);
      setAuthCookies(res, env.NODE_ENV, result);
      res.status(200).json({ user: result.user });
    } catch (error) {
      // A dead refresh token is useless: drop both cookies so the browser stops sending them.
      clearAuthCookies(res, env.NODE_ENV);
      throw error;
    }
  };

  // Always succeeds: sign-out is idempotent, and the cookies are cleared even if the session is gone.
  const postLogout: RequestHandler = async (req, res) => {
    const refreshToken = readCookie(req, names.refresh);
    if (refreshToken) await logout(prisma, refreshToken);
    clearAuthCookies(res, env.NODE_ENV);
    res.status(204).end();
  };

  const getMe: RequestHandler = (req, res) => {
    res.status(200).json({ user: requireAuth(req) });
  };

  const postChangePassword: RequestHandler = async (req, res) => {
    const { body } = getValidated<typeof changePasswordSchemas>(res);
    await changeOwnPassword(prisma, requireAuth(req).id, req.sessionId, body);
    res.status(204).end();
  };

  return { postLogin, postRefresh, postLogout, getMe, postChangePassword };
}
