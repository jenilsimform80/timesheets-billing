import { render } from '@testing-library/react';
import { vi } from 'vitest';
import { createMemoryRouter, RouterProvider, type RouteObject } from 'react-router';
import type { Project, TimeEntry, User, WeekSummary } from '../src/api/types';
import { routes } from '../src/routes';
import { mondayOf, todayIso } from '../src/lib/dates';

// ---------- responses ----------
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
export const ok = (body: unknown, status = 200) => jsonResponse(body, status);
export const noContent = () => new Response(null, { status: 204 });
export const fail = (status: number, code: string, message: string, details?: unknown) =>
  jsonResponse({ error: { code, message, ...(details !== undefined && { details }) } }, status);

export const healthOk = () =>
  jsonResponse({ status: 'ok', uptimeSeconds: 42, timestamp: '2026-03-02T10:00:00.000Z' });
export const dbUp = () => jsonResponse({ status: 'ok', database: 'up' });
export const dbDown = () => jsonResponse({ status: 'unavailable', database: 'down' }, 503);

// ---------- request mocking ----------
export interface MockRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  params: Record<string, string>;
}
type Responder = Response | ((req: MockRequest) => Response | Promise<Response>);

const unmatched: string[] = [];

/** Called after every test: a request nobody mocked is a test bug, never silently ignored. */
export function assertNoUnmatchedRequests(): void {
  if (unmatched.length > 0) {
    const list = unmatched.splice(0).join(', ');
    throw new Error(`Unmocked API request(s): ${list}`);
  }
}

function compile(key: string) {
  const [method, pattern] = key.split(' ') as [string, string];
  const names: string[] = [];
  const regex = new RegExp(
    '^' +
      pattern.replace(/:([A-Za-z]+)/g, (_m, name: string) => (names.push(name), '([^/]+)')) +
      '$',
  );
  return { method, regex, names, key };
}

/**
 * Stubs global fetch. Handlers are keyed "METHOD /path" (path without /api, `:param` allowed).
 * Without a `GET /auth/me` handler the visitor is signed out (401); a 401 first tries a silent
 * `POST /auth/refresh`, which by default is refused too (no refresh cookie).
 */
export function mockApi(handlers: Record<string, Responder> = {}) {
  const table = { ...handlers };
  if (!('GET /auth/me' in table)) {
    table['GET /auth/me'] = fail(401, 'UNAUTHENTICATED', 'Authentication required');
    if (!('POST /auth/refresh' in table)) {
      table['POST /auth/refresh'] = fail(
        401,
        'UNAUTHENTICATED',
        'Invalid or expired refresh token',
      );
    }
  }
  const compiled = Object.keys(table).map(compile);
  const requests: MockRequest[] = [];

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, 'http://localhost');
    const path = url.pathname.replace(/^\/api/, '');
    const method = (init?.method ?? 'GET').toUpperCase();

    for (const route of compiled) {
      if (route.method !== method) continue;
      const match = route.regex.exec(path);
      if (!match) continue;
      const params: Record<string, string> = {};
      route.names.forEach((name, i) => (params[name] = decodeURIComponent(match[i + 1] ?? '')));
      const request: MockRequest = {
        method,
        path,
        query: url.searchParams,
        body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
        params,
      };
      requests.push(request);
      const responder = table[route.key]!;
      return typeof responder === 'function' ? responder(request) : responder.clone();
    }
    unmatched.push(`${method} ${path}`);
    return fail(500, 'UNMOCKED', `No mock for ${method} ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);

  return {
    fetchMock,
    requests,
    /** Recorded requests for e.g. "POST /time-entries". */
    calls: (key: string) =>
      requests.filter(
        (r) =>
          `${r.method} ${r.path}` === key ||
          (compile(key).regex.test(r.path) && r.method === key.split(' ')[0]),
      ),
  };
}

// ---------- rendering ----------
export function renderRoutes(initialPath: string, routeTable: RouteObject[] = routes) {
  const router = createMemoryRouter(routeTable, { initialEntries: [initialPath] });
  return { router, ...render(<RouterProvider router={router} />) };
}

// ---------- fixtures ----------
export const users = {
  contributor: {
    id: 'u-dev',
    email: 'dev@example.com',
    name: 'Casey Contributor',
    role: 'CONTRIBUTOR',
    managerId: 'u-mgr',
  },
  manager: {
    id: 'u-mgr',
    email: 'manager@example.com',
    name: 'Morgan Manager',
    role: 'MANAGER',
    managerId: null,
  },
  admin: {
    id: 'u-admin',
    email: 'admin@example.com',
    name: 'Alex Admin',
    role: 'ADMIN',
    managerId: null,
  },
} satisfies Record<string, User>;

/** The body of a successful login/refresh: only the user (the tokens are HttpOnly cookies). */
export const tokenResponse = (user: User) => ok({ user });

/**
 * Handlers for a signed-in visitor. The real app cannot see its HttpOnly cookies; it learns who it
 * is by asking `/auth/me`, which is exactly what this answers.
 */
export const signedInAs = (user: User): Record<string, Responder> => ({
  'GET /auth/me': ok({ user }),
});

export const project = (overrides: Partial<Project> = {}): Project => ({
  id: 'p1',
  code: 'ALPHA',
  name: 'Alpha Platform',
  clientName: 'Acme',
  budgetHours: 100,
  startDate: null,
  endDate: null,
  isActive: true,
  isRestricted: false,
  tasks: [
    { id: 't1', name: 'Build', isActive: true, canLog: true, canManage: true },
    { id: 't2', name: 'Review', isActive: true, canLog: true, canManage: true },
  ],
  ...overrides,
});

export const entry = (overrides: Partial<TimeEntry> = {}): TimeEntry => ({
  id: 'e1',
  userId: 'u-dev',
  projectId: 'p1',
  taskId: 't1',
  workDate: '2026-03-02',
  hours: 8,
  isBillable: true,
  notes: null,
  createdAt: '2026-03-02T09:00:00.000Z',
  updatedAt: '2026-03-02T09:00:00.000Z',
  ...overrides,
});

export const week = (overrides: Partial<WeekSummary> = {}): WeekSummary => {
  const entries = overrides.entries ?? [];
  const dailyTotals: Record<string, number> = {};
  let weeklyTotal = 0;
  let billableTotal = 0;
  for (const e of entries) {
    dailyTotals[e.workDate] = (dailyTotals[e.workDate] ?? 0) + e.hours;
    weeklyTotal += e.hours;
    if (e.isBillable) billableTotal += e.hours;
  }
  return {
    userId: 'u-dev',
    weekStart: '2026-03-02',
    weekEnd: '2026-03-08',
    status: 'DRAFT',
    submission: null,
    entries,
    dailyTotals,
    weeklyTotal,
    billableTotal,
    nonBillableTotal: weeklyTotal - billableTotal,
    warnings: [],
    ...overrides,
  };
};

/** Empty-but-valid responses for everything the home dashboard loads (spread into mockApi). */
export const dashboardApi = (): Record<string, Responder> => ({
  'GET /timesheets/:weekStart': () => ok(week({ weekStart: mondayOf(todayIso()) })),
  'GET /reports/hours': () =>
    ok({
      from: '2026-01-01',
      to: '2026-12-31',
      groupBy: [],
      rows: [],
      totals: { totalHours: 0, billableHours: 0, nonBillableHours: 0, entryCount: 0 },
      truncated: false,
    }),
  'GET /submissions': ok({ submissions: [] }),
  'GET /users': ok({ users: [] }),
  'GET /reports/project-budgets': ok({
    through: null,
    projects: [],
    totals: { budgetHours: 0, loggedHours: 0 },
  }),
});
