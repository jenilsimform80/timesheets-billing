import { config } from '../config/env';
import { ApiError, isApiErrorBody } from './errors';

type UnauthorizedHandler = () => void;
let unauthorizedHandler: UnauthorizedHandler | null = null;

/**
 * Registers the app-wide reaction to "your session is no longer valid" (HTTP 401 on any call
 * except those that opt out). The auth layer uses it to drop the signed-in user and send them to
 * the login page; the failed call still rejects with its ApiError.
 */
export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  unauthorizedHandler = handler;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** Query-string parameters; `undefined`/`null` values are omitted. */
  query?: Record<string, string | number | boolean | null | undefined>;
  /** JSON-serialisable request body. */
  body?: unknown;
  signal?: AbortSignal;
  /** Set false for calls where 401 is an expected answer (login, wrong password). Default true. */
  handleUnauthorized?: boolean;
  /**
   * Whether a 401 first triggers one silent session refresh and a replay. Defaults to
   * `handleUnauthorized`; set true on a call whose 401 can ALSO mean "wrong password" (change
   * password) so an expired access cookie is still renewed instead of shown as a form error.
   */
  silentRefresh?: boolean;
}

export function buildUrl(
  path: string,
  query: RequestOptions['query'],
  baseUrl: string = config.apiBaseUrl,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) params.set(key, String(value));
  }
  const qs = params.toString();
  return `${baseUrl}${path.startsWith('/') ? path : `/${path}`}${qs ? `?${qs}` : ''}`;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function toApiError(response: Response, payload: unknown): ApiError {
  if (isApiErrorBody(payload)) {
    const { code, message, details } = payload.error;
    return new ApiError(response.status, code, message, details, payload);
  }
  return new ApiError(
    response.status,
    'UNEXPECTED_RESPONSE',
    `The server answered ${response.status} ${response.statusText}`.trim(),
    undefined,
    payload,
  );
}

/**
 * One network round trip. Authentication is two HttpOnly cookies the browser attaches itself; this
 * code never sees, stores or sends a token. `credentials: 'include'` is needed because in dev the
 * API is another origin (http://localhost:3000, same-site as the app on :5173); the backend only
 * answers credentialed CORS requests from its allow-listed FRONTEND_URL. In production the app and
 * `/api` share one origin (nginx), where 'include' behaves like 'same-origin'.
 */
async function send(
  path: string,
  { method = 'GET', query, body, signal }: RequestOptions,
): Promise<{ response: Response; payload: unknown }> {
  let response: Response;
  try {
    response = await fetch(buildUrl(path, query), {
      method,
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      ...(signal && { signal }),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(0, 'NETWORK_ERROR', 'Could not reach the server. Check your connection.');
  }
  return { response, payload: await readJson(response) };
}

/**
 * Asks the server to rotate the refresh cookie and set a new access cookie. "Single flight": if
 * five requests hit 401 together they share ONE refresh call. That matters because refresh tokens
 * are single-use (rotation): a second parallel call would present the already-replaced token and
 * sign the user out.
 */
let refreshInFlight: Promise<boolean> | null = null;
function refreshSession(): Promise<boolean> {
  refreshInFlight ??= (async () => {
    try {
      const { response } = await send('/auth/refresh', { method: 'POST' });
      return response.ok; // false: rejected (expired, used, deactivated, no cookie) or server trouble
    } catch {
      return false;
    }
  })().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

/**
 * The only place that calls `fetch`. Sends the session cookies, speaks JSON, and turns every
 * failure into an `ApiError`. On a 401 it first tries ONE silent session refresh and replays the
 * request; only if that fails is the user treated as signed out. Cancellation (AbortError) is
 * passed through unchanged so callers can ignore it.
 */
export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { handleUnauthorized = true, silentRefresh = handleUnauthorized } = options;

  let { response, payload } = await send(path, options);

  // Login/logout (silentRefresh false) never refresh: a 401 there is the answer, not a stale token.
  if (response.status === 401 && silentRefresh) {
    if (await refreshSession()) {
      ({ response, payload } = await send(path, options));
    } else {
      // The session is really gone (refresh rejected): sign out even for calls that opted out.
      unauthorizedHandler?.();
      throw toApiError(response, payload);
    }
  }

  if (!response.ok) {
    if (response.status === 401 && handleUnauthorized) {
      unauthorizedHandler?.();
    }
    throw toApiError(response, payload);
  }

  return payload as T;
}
