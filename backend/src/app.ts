import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import type { Env } from './config/env.js';
import { cookieNames } from './auth/auth-cookies.js';
import { createErrorHandler, notFoundHandler } from './middleware/error-handler.js';
import { createOriginCheck } from './middleware/origin-check.js';
import { rejectNulBytes } from './middleware/reject-nul.js';
import { mountApiDocs } from './routes/docs.routes.js';
import { createApiRouter, type AppDependencies } from './routes/index.js';

export function createApp(env: Env, deps: AppDependencies): Express {
  const app = express();

  app.disable('x-powered-by');
  // Authenticated JSON must never be reused from a browser/proxy cache for another user: no ETag
  // (no conditional-request path), `no-store`, and `Vary: Cookie` for caches that ignore no-store.
  app.disable('etag');
  app.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.vary('Cookie');
    next();
  });
  // Trust exactly N proxy hops (never "true"); 0 means X-Forwarded-For is ignored.
  if (env.TRUST_PROXY > 0) app.set('trust proxy', env.TRUST_PROXY);
  app.locals['jwtSecret'] = env.JWT_SECRET;
  app.locals['cookieNames'] = cookieNames(env.NODE_ENV);
  app.use(helmet());
  app.use(cors({ origin: env.FRONTEND_URL, credentials: true }));
  app.use(express.json({ limit: '100kb' }));
  app.use(rejectNulBytes);
  app.use(cookieParser());
  app.use(createOriginCheck(env.FRONTEND_URL));

  mountApiDocs(app, env);
  app.use('/api', createApiRouter(deps, env));

  app.use(notFoundHandler);
  app.use(createErrorHandler({ logErrors: env.NODE_ENV !== 'test' }));

  return app;
}
