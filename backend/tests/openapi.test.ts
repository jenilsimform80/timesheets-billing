import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildOpenApiDocument, toOpenApiPath } from '../src/docs/openapi.js';
import {
  buildTestApp,
  createTestPrisma,
  createUser,
  loginToken,
  resetDatabase,
  setCookies,
  testEnv,
  TEST_PASSWORD,
} from './helpers.js';

type Schema = Record<string, unknown>;
interface Doc {
  openapi: string;
  paths: Record<string, Record<string, { responses: Record<string, Schema>; security: unknown[] }>>;
  components: { schemas: Record<string, Schema>; securitySchemes: Record<string, Schema> };
}

const doc = buildOpenApiDocument() as unknown as Doc;

// ---------- a tiny response validator (no dependency): the subset of JSON Schema the spec uses ----------
const FORMATS: Record<string, RegExp> = {
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  date: /^\d{4}-\d{2}-\d{2}$/,
  'date-time': /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/,
  email: /^\S+@\S+$/,
};

function resolve(schema: Schema): Schema {
  const target = schema['$ref'];
  if (typeof target !== 'string') return schema;
  return doc.components.schemas[target.replace('#/components/schemas/', '')]!;
}

/** Returns a list of problems (empty = the value matches the schema). Unknown object keys are problems. */
function check(schemaIn: Schema, value: unknown, path = '$'): string[] {
  const schema = resolve(schemaIn);
  if (value === null) return schema['nullable'] === true ? [] : [`${path}: unexpected null`];
  const problems: string[] = [];
  const type = schema['type'];
  const enumValues = schema['enum'] as unknown[] | undefined;
  if (enumValues && !enumValues.includes(value))
    problems.push(`${path}: ${JSON.stringify(value)} not in enum`);

  if (type === 'string') {
    if (typeof value !== 'string') return [`${path}: expected string, got ${typeof value}`];
    const format = schema['format'] as string | undefined;
    if (format && FORMATS[format] && !FORMATS[format].test(value))
      problems.push(`${path}: bad ${format} "${value}"`);
  } else if (type === 'number' || type === 'integer') {
    if (typeof value !== 'number') return [`${path}: expected number, got ${typeof value}`];
    if (type === 'integer' && !Number.isInteger(value)) problems.push(`${path}: expected integer`);
  } else if (type === 'boolean') {
    if (typeof value !== 'boolean') return [`${path}: expected boolean`];
  } else if (type === 'array') {
    if (!Array.isArray(value)) return [`${path}: expected array`];
    value.forEach((item, i) =>
      problems.push(...check(schema['items'] as Schema, item, `${path}[${i}]`)),
    );
  } else if (type === 'object') {
    if (typeof value !== 'object' || Array.isArray(value)) return [`${path}: expected object`];
    const record = value as Record<string, unknown>;
    const properties = (schema['properties'] ?? {}) as Record<string, Schema>;
    const extra = schema['additionalProperties'];
    for (const key of (schema['required'] ?? []) as string[]) {
      if (!(key in record)) problems.push(`${path}.${key}: required but missing`);
    }
    for (const [key, item] of Object.entries(record)) {
      if (key in properties) problems.push(...check(properties[key]!, item, `${path}.${key}`));
      else if (extra && typeof extra === 'object')
        problems.push(...check(extra as Schema, item, `${path}.${key}`));
      else if (extra !== true) problems.push(`${path}.${key}: not documented`);
    }
  }
  return problems;
}

// ---------- the live scenario ----------
const prisma = createTestPrisma();
const app = buildTestApp(prisma);
const cookies: Record<string, string> = {};
const visited = new Set<string>();

/** Calls the real API and asserts the status is documented and the body matches the documented schema. */
async function call(
  who: 'admin' | 'manager' | 'dev' | 'anon',
  method: 'get' | 'post' | 'patch' | 'delete',
  template: string,
  url: string,
  body?: object,
  rawCookie?: string, // an explicit Cookie header, e.g. the refresh cookie for /auth/refresh
) {
  let req = request(app)[method](`/api${url}`);
  if (who !== 'anon') req = req.set('Cookie', cookies[who]!);
  if (rawCookie) req = req.set('Cookie', rawCookie);
  const res = body ? await req.send(body) : await req.send();

  const operation = doc.paths[toOpenApiPath(template)]?.[method];
  expect(operation, `${method.toUpperCase()} ${template} is not documented`).toBeDefined();
  const response = operation!.responses[String(res.status)];
  expect(
    response,
    `${method.toUpperCase()} ${template} returned undocumented status ${res.status}: ${JSON.stringify(res.body)}`,
  ).toBeDefined();
  const content = (response as { content?: Record<string, { schema: Schema }> }).content;
  if (content) {
    const problems = check(content['application/json']!.schema, res.body);
    expect(problems, `${method.toUpperCase()} ${template} -> ${res.status}`).toEqual([]);
  } else {
    expect(res.status === 204 || res.text === '' || res.body !== undefined).toBe(true);
  }
  visited.add(`${method.toUpperCase()} ${toOpenApiPath(template)}`);
  return res;
}

beforeAll(async () => {
  await resetDatabase(prisma);
  await createUser(prisma, { email: 'admin@t.dev', role: 'ADMIN' });
  const manager = await createUser(prisma, { email: 'manager@t.dev', role: 'MANAGER' });
  await createUser(prisma, { email: 'dev@t.dev', managerId: manager.id });
  for (const who of ['admin', 'manager', 'dev'])
    cookies[who] = await loginToken(app, `${who}@t.dev`);
});
afterAll(async () => {
  await resetDatabase(prisma);
  await prisma.$disconnect();
});

describe('documentation endpoints', () => {
  it('serves the OpenAPI JSON at /api-docs.json', async () => {
    const res = await request(app).get('/api-docs.json');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect((res.body as Doc).openapi).toBe('3.0.3');
    expect(Object.keys((res.body as Doc).paths).length).toBeGreaterThan(20);
  });

  it('serves Swagger UI at /api-docs and its script from the same origin', async () => {
    const page = await request(app).get('/api-docs/');
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toMatch(/text\/html/);
    expect(page.text).toContain('swagger-ui');
    expect(page.text).not.toMatch(
      /https?:\/\/(?!localhost)[a-z0-9.-]+\.[a-z]{2,}\/[^"']*\.(js|css)/i,
    ); // no CDN assets
    expect((await request(app).get('/api-docs/swagger-ui-init.js')).status).toBe(200);
    expect((await request(app).get('/api-docs')).status).toBeLessThan(400);
  });

  it('is off in production by default, with the normal JSON 404', async () => {
    const prod = buildTestApp(prisma, { NODE_ENV: 'production' });
    for (const path of ['/api-docs.json', '/api-docs/']) {
      const res = await request(prod).get(path);
      expect(res.status).toBe(404);
      expect((res.body as { error: { code: string } }).error.code).toBe('NOT_FOUND');
    }
  });

  it('can be forced on in production and off elsewhere', async () => {
    const on = buildTestApp(prisma, { NODE_ENV: 'production', API_DOCS_ENABLED: true });
    expect((await request(on).get('/api-docs.json')).status).toBe(200);
    const off = buildTestApp(prisma, { API_DOCS_ENABLED: false });
    expect((await request(off).get('/api-docs.json')).status).toBe(404);
  });

  it('documents HttpOnly cookie authentication (and no bearer scheme)', async () => {
    const body = (await request(app).get('/api-docs.json')).body as Doc;
    expect(body.components.securitySchemes['cookieAuth']).toMatchObject({
      type: 'apiKey',
      in: 'cookie',
      name: 'at',
    });
    expect(body.components.securitySchemes['bearerAuth']).toBeUndefined();
  });

  it('contains no secrets or environment values', () => {
    const text = JSON.stringify(doc);
    for (const secret of [
      testEnv.DATABASE_URL,
      testEnv.JWT_SECRET,
      TEST_PASSWORD,
      'postgresql://',
      'password_hash',
      '$argon2',
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toContain(process.env['DATABASE_URL'] ?? '\u0000');
  });
});

describe('specification structure', () => {
  it('has only resolvable $refs and a response for every operation', () => {
    const refs = [
      ...JSON.stringify(doc).matchAll(/"\$ref":"#\/components\/schemas\/([A-Za-z]+)"/g),
    ].map((m) => m[1]!);
    for (const name of refs)
      expect(doc.components.schemas[name], `dangling $ref ${name}`).toBeDefined();
    for (const [path, methods] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        expect(Object.keys(op.responses).length, `${method} ${path}`).toBeGreaterThan(0);
      }
    }
  });

  it('marks every operation as public or cookie-protected', () => {
    for (const methods of Object.values(doc.paths)) {
      for (const op of Object.values(methods)) {
        expect(
          op.security.length === 0 || JSON.stringify(op.security) === '[{"cookieAuth":[]}]',
        ).toBe(true);
      }
    }
  });

  it('documents exactly the routes the application registers', () => {
    const routesDir = join(import.meta.dirname, '..', 'src', 'routes');
    const index = readFileSync(join(routesDir, 'index.ts'), 'utf8');
    const mounts = new Map<string, string>(); // factory name -> mount prefix
    for (const m of index.matchAll(/router\.use\('([^']+)',\s*(create\w+Router)\(/g))
      mounts.set(m[2]!, m[1]!);

    const registered = new Set<string>();
    for (const file of readdirSync(routesDir).filter(
      (f) => f.endsWith('.routes.ts') && f !== 'docs.routes.ts',
    )) {
      const source = readFileSync(join(routesDir, file), 'utf8');
      const factory = /export function (create\w+Router)/.exec(source)?.[1];
      const prefix = factory ? mounts.get(factory) : undefined;
      expect(prefix, `${file} is not mounted in routes/index.ts`).toBeDefined();
      for (const m of source.matchAll(/router\.(get|post|put|patch|delete)\(\s*'([^']*)'/g)) {
        const sub = m[2] === '/' ? '' : m[2]!;
        registered.add(`${m[1]!.toUpperCase()} ${toOpenApiPath(prefix! + sub)}`);
      }
    }

    const documented = new Set<string>();
    for (const [path, methods] of Object.entries(doc.paths)) {
      for (const method of Object.keys(methods)) documented.add(`${method.toUpperCase()} ${path}`);
    }
    expect([...registered].filter((r) => !documented.has(r))).toEqual([]); // undocumented routes
    expect([...documented].filter((d) => !registered.has(d))).toEqual([]); // documented but not real
    expect(registered.size).toBe(36);
  });
});

describe('documented behaviour matches the real API', () => {
  const ids: Record<string, string> = {};

  it('health, auth and user administration', async () => {
    expect((await call('anon', 'get', '/health', '/health')).status).toBe(200);
    expect((await call('anon', 'get', '/health/db', '/health/db')).status).toBe(200);

    expect(
      (
        await call('anon', 'post', '/auth/login', '/auth/login', {
          email: 'dev@t.dev',
          password: TEST_PASSWORD,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call('anon', 'post', '/auth/login', '/auth/login', {
          email: 'dev@t.dev',
          password: 'wrong-password',
        })
      ).status,
    ).toBe(401);
    expect(
      (await call('anon', 'post', '/auth/login', '/auth/login', { email: 'nope' })).status,
    ).toBe(400);
    expect((await call('dev', 'get', '/auth/me', '/auth/me')).status).toBe(200);
    expect((await call('anon', 'get', '/auth/me', '/auth/me')).status).toBe(401);

    const users = await call('admin', 'get', '/users', '/users');
    ids['manager'] = (users.body as { users: { id: string; email: string }[] }).users.find(
      (u) => u.email === 'manager@t.dev',
    )!.id;
    ids['dev'] = (users.body as { users: { id: string; email: string }[] }).users.find(
      (u) => u.email === 'dev@t.dev',
    )!.id;
    expect((await call('dev', 'get', '/users', '/users')).status).toBe(200);
    expect(
      (await call('manager', 'get', '/users/direct-reports', '/users/direct-reports')).status,
    ).toBe(200);
    expect(
      (await call('dev', 'get', '/users/direct-reports', '/users/direct-reports')).status,
    ).toBe(403);
    expect((await call('dev', 'get', '/users/:id', `/users/${ids['dev']}`)).status).toBe(200);
    expect((await call('dev', 'get', '/users/:id', `/users/${ids['manager']}`)).status).toBe(404);

    const created = await call('admin', 'post', '/users', '/users', {
      email: 'new@t.dev',
      name: 'New Person',
      role: 'CONTRIBUTOR',
      password: 'Docs-Test-Pass-1',
      managerId: ids['manager'],
    });
    expect(created.status).toBe(201);
    expect(
      (
        await call('admin', 'post', '/users', '/users', {
          email: 'new@t.dev',
          name: 'Dup',
          role: 'MANAGER',
          password: 'Docs-Test-Pass-1',
        })
      ).status,
    ).toBe(409);
    expect((await call('dev', 'post', '/users', '/users', {})).status).toBe(403);
    expect(
      (
        await call('admin', 'post', '/users', '/users', {
          email: 'bad@t.dev',
          name: 'Bad',
          role: 'CONTRIBUTOR',
          password: 'Docs-Test-Pass-1',
          managerId: ids['dev'],
        })
      ).status,
    ).toBe(422);
    const newId = (created.body as { user: { id: string } }).user.id;
    expect(
      (await call('admin', 'patch', '/users/:id', `/users/${newId}`, { name: 'Renamed' })).status,
    ).toBe(200);
    expect(
      (await call('admin', 'patch', '/users/:id', `/users/${ids['manager']}`, { isActive: false }))
        .status,
    ).toBe(422);
    expect(
      (
        await call('admin', 'post', '/users/:id/password', `/users/${newId}/password`, {
          password: 'Another-Pass-22',
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await call('admin', 'post', '/users/:id/password', `/users/${newId}/password`, {
          password: 'x',
        })
      ).status,
    ).toBe(400);

    expect(
      (
        await call('manager', 'post', '/auth/change-password', '/auth/change-password', {
          currentPassword: 'nope-nope-nope',
          newPassword: 'Brand-New-Pass-3',
        })
      ).status,
    ).toBe(401);
  });

  it('projects, tasks, time entries and the week view', async () => {
    const project = await call('admin', 'post', '/projects', '/projects', {
      code: 'DOCS',
      name: 'Docs Project',
      budgetHours: 40,
    });
    expect(project.status).toBe(201);
    ids['project'] = (project.body as { project: { id: string } }).project.id;
    expect(
      (
        await call('admin', 'post', '/projects', '/projects', {
          code: 'DOCS',
          name: 'Dup',
          budgetHours: 1,
        })
      ).status,
    ).toBe(409);
    expect((await call('dev', 'post', '/projects', '/projects', {})).status).toBe(403);
    const task = await call(
      'admin',
      'post',
      '/projects/:id/tasks',
      `/projects/${ids['project']}/tasks`,
      { name: 'Build' },
    );
    expect(task.status).toBe(201);
    ids['task'] = (task.body as { task: { id: string } }).task.id;
    expect(
      (
        await call(
          'admin',
          'patch',
          '/projects/:id/tasks/:taskId',
          `/projects/${ids['project']}/tasks/${ids['task']}`,
          { name: 'Build v2' },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await call('admin', 'patch', '/projects/:id', `/projects/${ids['project']}`, {
          clientName: 'Acme',
        })
      ).status,
    ).toBe(200);
    expect((await call('dev', 'get', '/projects', '/projects')).status).toBe(200); // budgetHours omitted for non-admins
    expect((await call('admin', 'get', '/projects', '/projects?includeArchived=true')).status).toBe(
      200,
    );
    expect((await call('dev', 'get', '/projects', '/projects?includeArchived=true')).status).toBe(
      403,
    );
    expect((await call('dev', 'get', '/projects/:id', `/projects/${ids['project']}`)).status).toBe(
      200,
    );
    expect(
      (await call('dev', 'get', '/projects/:id', '/projects/00000000-0000-4000-8000-000000000000'))
        .status,
    ).toBe(404);

    const entry = await call('dev', 'post', '/time-entries', '/time-entries', {
      projectId: ids['project'],
      taskId: ids['task'],
      workDate: '2026-03-03',
      hours: 8,
      isBillable: true,
      notes: 'work',
    });
    expect(entry.status).toBe(201);
    ids['entry'] = (entry.body as { entry: { id: string } }).entry.id;
    expect(
      (
        await call('dev', 'post', '/time-entries', '/time-entries', {
          projectId: ids['project'],
          taskId: ids['task'],
          workDate: '2026-03-03',
          hours: 17,
          isBillable: true,
        })
      ).status,
    ).toBe(422);
    expect(
      (await call('dev', 'post', '/time-entries', '/time-entries', { projectId: ids['project'] }))
        .status,
    ).toBe(400);
    expect(
      (await call('dev', 'get', '/time-entries', '/time-entries?from=2026-03-01&to=2026-03-31'))
        .status,
    ).toBe(200);
    expect(
      (await call('manager', 'get', '/time-entries/:id', `/time-entries/${ids['entry']}`)).status,
    ).toBe(200);
    expect(
      (
        await call('manager', 'patch', '/time-entries/:id', `/time-entries/${ids['entry']}`, {
          hours: 1,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call('dev', 'patch', '/time-entries/:id', `/time-entries/${ids['entry']}`, {
          hours: 7.5,
        })
      ).status,
    ).toBe(200);
    const week = await call('dev', 'get', '/timesheets/:weekStart', '/timesheets/2026-03-02');
    expect(week.status).toBe(200);
    expect(
      (await call('dev', 'get', '/timesheets/:weekStart', '/timesheets/2026-03-03')).status,
    ).toBe(400); // not a Monday
    const extra = await call('dev', 'post', '/time-entries', '/time-entries', {
      projectId: ids['project'],
      taskId: ids['task'],
      workDate: '2026-03-04',
      hours: 1,
      isBillable: false,
    });
    expect(
      (
        await call(
          'dev',
          'delete',
          '/time-entries/:id',
          `/time-entries/${(extra.body as { entry: { id: string } }).entry.id}`,
        )
      ).status,
    ).toBe(204);
  });

  it('submission, approval, locking, audit and reports', async () => {
    const submitted = await call('dev', 'post', '/submissions', '/submissions', {
      weekStart: '2026-03-02',
    });
    expect(submitted.status).toBe(201);
    ids['submission'] = (submitted.body as { submission: { id: string } }).submission.id;
    expect(
      (await call('dev', 'post', '/submissions', '/submissions', { weekStart: '2026-03-02' }))
        .status,
    ).toBe(409);
    expect(
      (await call('dev', 'post', '/submissions', '/submissions', { weekStart: '2026-03-09' }))
        .status,
    ).toBe(422);
    expect(
      (
        await call('dev', 'post', '/time-entries', '/time-entries', {
          projectId: ids['project'],
          taskId: ids['task'],
          workDate: '2026-03-05',
          hours: 1,
          isBillable: true,
        })
      ).status,
    ).toBe(409); // frozen week
    expect(
      (await call('manager', 'get', '/submissions', '/submissions?forApproval=true')).status,
    ).toBe(200);
    expect((await call('dev', 'get', '/submissions', '/submissions?forApproval=true')).status).toBe(
      403,
    );
    expect(
      (await call('manager', 'get', '/submissions/:id', `/submissions/${ids['submission']}`))
        .status,
    ).toBe(200);
    expect(
      (
        await call(
          'dev',
          'post',
          '/submissions/:id/approve',
          `/submissions/${ids['submission']}/approve`,
          {},
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call(
          'manager',
          'post',
          '/submissions/:id/reject',
          `/submissions/${ids['submission']}/reject`,
          {},
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await call(
          'manager',
          'post',
          '/submissions/:id/reject',
          `/submissions/${ids['submission']}/reject`,
          { comment: 'Fix hours' },
        )
      ).status,
    ).toBe(200);
    expect(
      (await call('dev', 'post', '/submissions', '/submissions', { weekStart: '2026-03-02' }))
        .status,
    ).toBe(201);
    expect(
      (
        await call(
          'manager',
          'post',
          '/submissions/:id/approve',
          `/submissions/${ids['submission']}/approve`,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await call(
          'manager',
          'post',
          '/submissions/:id/approve',
          `/submissions/${ids['submission']}/approve`,
          { comment: 'again' },
        )
      ).status,
    ).toBe(409);

    expect(
      (await call('dev', 'post', '/locked-periods', '/locked-periods', { period: '2026-03' }))
        .status,
    ).toBe(403);
    expect(
      (
        await call('admin', 'post', '/locked-periods', '/locked-periods', {
          period: '2026-03',
          note: 'March close',
        })
      ).status,
    ).toBe(201);
    expect(
      (await call('admin', 'post', '/locked-periods', '/locked-periods', { period: '2026-03' }))
        .status,
    ).toBe(409);
    expect((await call('dev', 'get', '/locked-periods', '/locked-periods')).status).toBe(200);
    const locked = await call(
      'dev',
      'patch',
      '/time-entries/:id',
      `/time-entries/${ids['entry']}`,
      { hours: 2 },
    );
    expect(locked.status).toBe(409); // WEEK_NOT_EDITABLE or PERIOD_LOCKED, both documented
    expect(
      (
        await call(
          'admin',
          'post',
          '/locked-periods/:period/unlock',
          '/locked-periods/2026-04/unlock',
          { reason: 'testing' },
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await call(
          'admin',
          'post',
          '/locked-periods/:period/unlock',
          '/locked-periods/2026-03/unlock',
          { reason: 'reopen for test' },
        )
      ).status,
    ).toBe(204);

    expect((await call('admin', 'get', '/audit-logs', '/audit-logs?limit=5')).status).toBe(200);
    expect((await call('dev', 'get', '/audit-logs', '/audit-logs')).status).toBe(403);
    expect(
      (
        await call(
          'dev',
          'get',
          '/reports/hours',
          '/reports/hours?from=2026-03-01&to=2026-03-31&groupBy=project,month',
        )
      ).status,
    ).toBe(200);
    expect(
      (await call('dev', 'get', '/reports/hours', '/reports/hours?from=2026-03-01')).status,
    ).toBe(400);
    expect(
      (await call('admin', 'get', '/reports/project-budgets', '/reports/project-budgets')).status,
    ).toBe(200);
    expect(
      (await call('manager', 'get', '/reports/project-budgets', '/reports/project-budgets')).status,
    ).toBe(403);

    expect(
      (
        await call('dev', 'post', '/auth/change-password', '/auth/change-password', {
          currentPassword: TEST_PASSWORD,
          newPassword: 'Brand-New-Pass-3',
        })
      ).status,
    ).toBe(204);
    const session = await call('anon', 'post', '/auth/login', '/auth/login', {
      email: 'dev@t.dev',
      password: 'Brand-New-Pass-3',
    });
    const refreshToken = setCookies(session)['rt']!;
    const refreshed = await call(
      'anon',
      'post',
      '/auth/refresh',
      '/auth/refresh',
      undefined,
      `rt=${refreshToken}`,
    );
    expect(refreshed.status).toBe(200);
    expect(
      (
        await call(
          'anon',
          'post',
          '/auth/refresh',
          '/auth/refresh',
          undefined,
          `rt=${refreshToken}`,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await call(
          'anon',
          'post',
          '/auth/logout',
          '/auth/logout',
          undefined,
          `rt=${setCookies(refreshed)['rt']!}`,
        )
      ).status,
    ).toBe(204);
  });

  it('exercised every documented operation', () => {
    const documented = Object.entries(doc.paths).flatMap(([path, methods]) =>
      Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`),
    );
    expect(documented.filter((d) => !visited.has(d))).toEqual([]);
  });
});
