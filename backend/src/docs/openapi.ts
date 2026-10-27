import { componentSchemas, ref } from './components.js';
import { operations, type Access, type OperationSpec } from './operations.js';
import { fromZod, parametersFrom, type Json } from './schema-utils.js';

/** Express `/projects/:id/tasks/:taskId` -> OpenAPI `/projects/{id}/tasks/{taskId}`. */
export const toOpenApiPath = (path: string): string => path.replace(/:([A-Za-z]+)/g, '{$1}');

const ERROR_EXAMPLES: Record<number, { code: string; message: string }> = {
  400: { code: 'VALIDATION_ERROR', message: 'Request validation failed' },
  401: { code: 'UNAUTHENTICATED', message: 'Authentication required' },
  403: { code: 'FORBIDDEN', message: 'You do not have permission to perform this action' },
  404: { code: 'NOT_FOUND', message: 'Not found' },
  409: { code: 'CONFLICT', message: 'Conflict' },
  422: { code: 'BUSINESS_RULE_VIOLATION', message: 'Business rule violated' },
  429: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again later.' },
  503: { code: 'SERVICE_UNAVAILABLE', message: 'The service is temporarily busy. Please retry.' },
};

function errorResponse(status: number, description: string): Json {
  const example = ERROR_EXAMPLES[status]!;
  return {
    description,
    content: {
      'application/json': {
        schema: ref(status === 400 ? 'ValidationErrorResponse' : 'ErrorResponse'),
        example: { error: example },
      },
    },
  };
}

const ACCESS_TEXT: Record<Access, string> = {
  public: 'No authentication required.',
  any: 'Any signed-in user.',
  CONTRIBUTOR: 'Contributors only.',
  MANAGER: 'Role **MANAGER** only (403 otherwise).',
  ADMIN: 'Role **ADMIN** only (403 otherwise).',
  ADMIN_OR_MANAGER: 'Roles **ADMIN** or **MANAGER** (403 otherwise).',
};

function buildOperation(op: OperationSpec): Json {
  const { request } = op;
  const parameters = [
    ...(request?.params ? parametersFrom(request.params, 'path') : []),
    ...(request?.query ? parametersFrom(request.query, 'query', op.paramDocs) : []),
  ];

  const responses: Record<string, Json> = {};
  const { success } = op;
  responses[String(success.status)] =
    success.status === 204 || !success.schema
      ? { description: success.description }
      : {
          description: success.description,
          content: { 'application/json': { schema: ref(success.schema) } },
        };

  const errors: Record<number, string> = {};
  if (request) errors[400] = 'Validation failed (`details` lists `{location, path, message}`).';
  if (op.access !== 'public')
    errors[401] = 'Missing, invalid or expired access cookie (`UNAUTHENTICATED`).';
  if (op.access === 'MANAGER' || op.access === 'ADMIN' || op.access === 'ADMIN_OR_MANAGER') {
    errors[403] = 'Your role is not allowed to do this (`FORBIDDEN`).';
  }
  Object.assign(errors, op.errors);
  for (const [status, description] of Object.entries(errors)) {
    responses[status] = errorResponse(Number(status), description);
  }

  return {
    tags: [op.tag],
    summary: op.summary,
    description: [ACCESS_TEXT[op.access], op.description].filter(Boolean).join('\n\n'),
    security: op.access === 'public' ? [] : [{ cookieAuth: [] }],
    ...(parameters.length > 0 && { parameters }),
    ...(request?.body && {
      requestBody: {
        required: request.bodyRequired ?? true,
        content: { 'application/json': { schema: fromZod(request.body) } },
      },
    }),
    responses,
  };
}

/** Builds the OpenAPI 3.0 document. Pure: no I/O, no secrets, nothing environment-specific. */
export function buildOpenApiDocument(): Json {
  const paths: Record<string, Json> = {};
  for (const op of operations) {
    const key = toOpenApiPath(op.path);
    (paths[key] ??= {})[op.method] = buildOperation(op);
  }

  const tags = [...new Set(operations.map((op) => op.tag))].map((name) => ({ name }));

  return {
    openapi: '3.0.3',
    info: {
      title: 'Timesheets and Project Billing API',
      version: '0.1.0',
      description: [
        'REST API for logging hours, weekly submission and approval, billing-period locking and reports.',
        '',
        '**Authentication.** HttpOnly cookies. `POST /auth/login` sets a short-lived access cookie (a JWT) and a refresh cookie; the browser sends them automatically (use *Try it out* after signing in, or a cookie jar with curl). When the access cookie expires, `POST /auth/refresh` rotates the refresh cookie and sets a new access cookie; the old refresh token stops working. `POST /auth/logout` ends the session and clears both cookies. State-changing requests from a browser must come from an allow-listed Origin (CSRF defence). `Authorization: Bearer` is not accepted.',
        '',
        '**Errors.** Every error is `{ "error": { "code", "message", "details"? } }`. Any endpoint can also return 413/415 (oversized or unsupported body), 500 (generic, no internals) or 503 (transient database condition; safe to retry).',
        '',
        '**Dates.** Calendar dates are `YYYY-MM-DD` (2000–2100) with no time zone. Weeks start on Monday.',
      ].join('\n'),
    },
    servers: [{ url: '/api', description: 'This server' }],
    tags,
    paths,
    components: {
      schemas: componentSchemas,
      securitySchemes: {
        cookieAuth: {
          type: 'apiKey',
          in: 'cookie',
          name: 'at',
          description:
            'HttpOnly access-token cookie set by `POST /auth/login` or `POST /auth/refresh` (named `__Host-at` in production). Also checked against its server-side session on every request, so logout and deactivation take effect immediately.',
        },
      },
    },
  };
}
