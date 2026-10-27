import { describe, expect, it, vi } from 'vitest';
import { apiRequest, buildUrl, setUnauthorizedHandler } from '../src/api/client';
import { ApiError } from '../src/api/errors';
import { jsonResponse } from './helpers';

const stub = (impl: (url: string, init?: RequestInit) => Promise<Response>) => {
  const mock = vi.fn(impl);
  vi.stubGlobal('fetch', mock);
  return mock;
};
const caught = async (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (e: unknown) => e,
  );

describe('buildUrl', () => {
  it('joins base, path and query, skipping empty values', () => {
    expect(buildUrl('/health', undefined, '/api')).toBe('/api/health');
    expect(buildUrl('health', undefined, '/api')).toBe('/api/health');
    expect(buildUrl('/x', { a: 1, b: 'two', c: true, d: undefined, e: null }, '/api')).toBe(
      '/api/x?a=1&b=two&c=true',
    );
  });

  it('encodes query values', () => {
    expect(buildUrl('/x', { q: 'a b&c=d' }, '/api')).toBe('/api/x?q=a+b%26c%3Dd');
  });
});

describe('apiRequest', () => {
  it('asks for JSON, with no body header, and lets the browser attach its cookies', async () => {
    const fetchMock = stub(() => Promise.resolve(jsonResponse({ ok: true })));

    const result = await apiRequest<{ ok: boolean }>('/ping');

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith('/api/ping', {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
  });

  it('serialises a JSON body with the right headers', async () => {
    const fetchMock = stub(() => Promise.resolve(jsonResponse({}, 201)));

    await apiRequest('/things', { method: 'POST', body: { name: 'x', n: 1 } });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"name":"x","n":1}');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(init.credentials).toBe('include'); // HttpOnly cookies ride along, also to the dev API origin
    expect(JSON.stringify(init.headers)).not.toMatch(/Authorization|Bearer/i);
  });

  it('returns undefined for 204 No Content', async () => {
    stub(() => Promise.resolve(new Response(null, { status: 204 })));

    await expect(apiRequest('/x', { method: 'DELETE' })).resolves.toBeUndefined();
  });

  it('turns the backend error envelope into an ApiError', async () => {
    stub(() =>
      Promise.resolve(
        jsonResponse(
          {
            error: {
              code: 'PERIOD_LOCKED',
              message: 'Period 2026-03 is locked',
              details: { period: '2026-03' },
            },
          },
          409,
        ),
      ),
    );

    const error = await caught(apiRequest('/x'));

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 409,
      code: 'PERIOD_LOCKED',
      message: 'Period 2026-03 is locked',
      details: { period: '2026-03' },
    });
  });

  it('reports a network failure as status 0 / NETWORK_ERROR', async () => {
    stub(() => Promise.reject(new TypeError('Failed to fetch')));

    const error = await caught(apiRequest('/x'));

    expect(error).toMatchObject({ status: 0, code: 'NETWORK_ERROR' });
    expect((error as ApiError).message).not.toContain('Failed to fetch');
  });

  it('reports a non-JSON error response as UNEXPECTED_RESPONSE without leaking its body', async () => {
    stub(() =>
      Promise.resolve(
        new Response('<html>Bad gateway: secret upstream</html>', {
          status: 502,
          statusText: 'Bad Gateway',
        }),
      ),
    );

    const error = (await caught(apiRequest('/x'))) as ApiError;

    expect(error).toMatchObject({ status: 502, code: 'UNEXPECTED_RESPONSE' });
    expect(error.message).toBe('The server answered 502 Bad Gateway');
    expect(error.message).not.toContain('secret');
  });

  it('keeps a non-envelope JSON body on the error (e.g. the 503 health answer)', async () => {
    stub(() => Promise.resolve(jsonResponse({ status: 'unavailable', database: 'down' }, 503)));

    const error = (await caught(apiRequest('/health/db'))) as ApiError;

    expect(error).toMatchObject({
      status: 503,
      code: 'UNEXPECTED_RESPONSE',
      body: { database: 'down' },
    });
  });

  it('passes cancellation through untouched so callers can ignore it', async () => {
    const controller = new AbortController();
    stub(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }),
    );

    const pending = caught(apiRequest('/slow', { signal: controller.signal }));
    controller.abort();

    const error = await pending;
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe('AbortError');
  });
});

describe('central 401 handling', () => {
  const unauthorized = () =>
    jsonResponse({ error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } }, 401);

  it('notifies the registered handler on a 401 and still rejects the call', async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    stub(() => Promise.resolve(unauthorized()));

    const error = await caught(apiRequest('/projects'));

    expect(handler).toHaveBeenCalledOnce();
    expect(error).toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
    setUnauthorizedHandler(null);
  });

  it('does not notify for calls where 401 is an expected answer', async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    stub(() => Promise.resolve(unauthorized()));

    await caught(
      apiRequest('/auth/login', { method: 'POST', body: {}, handleUnauthorized: false }),
    );

    expect(handler).not.toHaveBeenCalled();
    setUnauthorizedHandler(null);
  });

  it('does not notify for other error statuses', async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    stub(() => Promise.resolve(jsonResponse({ error: { code: 'FORBIDDEN', message: 'no' } }, 403)));

    await caught(apiRequest('/x'));

    expect(handler).not.toHaveBeenCalled();
    setUnauthorizedHandler(null);
  });
});

describe('session cookies', () => {
  const unauthorized = () =>
    jsonResponse({ error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } }, 401);
  const urlsOf = (m: ReturnType<typeof stub>) => m.mock.calls.map(([url]) => url);

  it('never sets an Authorization header: there is no token in JavaScript to send', async () => {
    const fetchMock = stub(() => Promise.resolve(jsonResponse({})));

    await apiRequest('/projects');

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.credentials).toBe('include');
    expect(init.headers).not.toHaveProperty('Authorization');
  });

  it('on 401 refreshes once (no body: the refresh cookie travels itself) and replays the request', async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    let refreshed = false;
    const fetchMock = stub((url) => {
      if (url.endsWith('/auth/refresh')) {
        refreshed = true;
        return Promise.resolve(jsonResponse({ user: {} }));
      }
      return Promise.resolve(refreshed ? jsonResponse({ ok: 1 }) : unauthorized());
    });

    await expect(apiRequest('/projects')).resolves.toEqual({ ok: 1 });

    expect(urlsOf(fetchMock)).toEqual(['/api/projects', '/api/auth/refresh', '/api/projects']);
    const refreshCall = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(refreshCall.method).toBe('POST');
    expect(refreshCall.body).toBeUndefined();
    expect(refreshCall.credentials).toBe('include');
    expect(handler).not.toHaveBeenCalled();
    setUnauthorizedHandler(null);
  });

  it('shares ONE refresh between parallel 401s (refresh tokens are single-use)', async () => {
    let refreshed = false;
    const fetchMock = stub((url) => {
      if (url.endsWith('/auth/refresh')) {
        refreshed = true;
        return Promise.resolve(jsonResponse({ user: {} }));
      }
      return Promise.resolve(refreshed ? jsonResponse({}) : unauthorized());
    });

    await Promise.all([apiRequest('/a'), apiRequest('/b'), apiRequest('/c')]);

    expect(urlsOf(fetchMock).filter((u) => u === '/api/auth/refresh')).toHaveLength(1);
  });

  it('when the refresh is rejected: signs the user out and rejects with the 401', async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    stub(() => Promise.resolve(unauthorized()));

    const error = await caught(apiRequest('/projects'));

    expect(error).toMatchObject({ status: 401 });
    expect(handler).toHaveBeenCalledOnce();
    setUnauthorizedHandler(null);
  });

  it('does not loop: a 401 after a successful refresh signs out instead of refreshing again', async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    const fetchMock = stub((url) =>
      Promise.resolve(url.endsWith('/auth/refresh') ? jsonResponse({ user: {} }) : unauthorized()),
    );

    await caught(apiRequest('/projects'));

    expect(urlsOf(fetchMock).filter((u) => u === '/api/auth/refresh')).toHaveLength(1);
    expect(handler).toHaveBeenCalledOnce();
    setUnauthorizedHandler(null);
  });

  it('does not refresh for calls where a 401 is the answer (e.g. login)', async () => {
    const fetchMock = stub(() => Promise.resolve(unauthorized()));

    await caught(
      apiRequest('/auth/login', { method: 'POST', body: {}, handleUnauthorized: false }),
    );

    expect(urlsOf(fetchMock)).toEqual(['/api/auth/login']);
  });

  it('keeps no token anywhere in browser storage', async () => {
    stub(() =>
      Promise.resolve(jsonResponse({ user: {}, accessToken: 'leak', refreshToken: 'leak' })),
    );

    await apiRequest('/auth/login', { method: 'POST', body: {} });

    expect(window.sessionStorage.length).toBe(0);
    expect(window.localStorage.length).toBe(0);
  });
});
