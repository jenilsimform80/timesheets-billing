import type { Express } from 'express';
import request from 'supertest';
import type { Env } from '../src/config/env.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth/password.js';
import { createPrismaClient } from '../src/db/prisma.js';
import type { PrismaClient, Role } from '../src/generated/prisma/client.js';
import { createTestPrisma } from './db-helper.js';

export const testEnv: Env = {
  NODE_ENV: 'test',
  PORT: 3000,
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/unused',
  JWT_SECRET: 'test-only-secret-test-only-secret-0123456789',
  ACCESS_TOKEN_TTL_MINUTES: 15,
  SESSION_TTL_HOURS: 8,
  TRUST_PROXY: 0,
  // High so suites that log in many times never hit it; the dedicated test builds its own app.
  LOGIN_ATTEMPT_LIMIT_MAX: 1_000_000,
  // High by default so unrelated tests never trip it; the rate-limit test builds its own app.
  LOGIN_RATE_LIMIT_MAX: 1000,
  LOGIN_RATE_LIMIT_WINDOW_MINUTES: 15,
  FRONTEND_URL: ['http://localhost:5173'],
  API_DOCS_ENABLED: undefined, // default: on outside production
};

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export function buildTestApp(prisma: PrismaClient, overrides: Partial<Env> = {}) {
  return createApp({ ...testEnv, ...overrides }, { prisma });
}

/** A Prisma client that cannot connect, to prove failure handling without touching real data. */
export function createUnreachablePrisma(): PrismaClient {
  return createPrismaClient('postgresql://nobody:nothing@127.0.0.1:1/missing');
}

export const TEST_PASSWORD = 'Correct-Horse-Battery-9';

let cachedHash: Promise<string> | undefined;

/** Creates a user with the shared test password (hash computed once per test file). */
export async function createUser(
  prisma: PrismaClient,
  data: {
    email: string;
    name?: string;
    role?: Role;
    managerId?: string | null;
    isActive?: boolean;
  },
) {
  cachedHash ??= hashPassword(TEST_PASSWORD);
  return prisma.user.create({
    data: {
      email: data.email,
      name: data.name ?? data.email.split('@')[0] ?? 'user',
      role: data.role ?? 'CONTRIBUTOR',
      managerId: data.managerId ?? null,
      isActive: data.isActive ?? true,
      passwordHash: await cachedHash,
    },
  });
}

/** Deletes all rows (children first). Only ever used on the guarded test database. */
export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  await prisma.session.deleteMany();
  // audit_logs is append-only (DELETE is blocked by a trigger); TRUNCATE does not fire row triggers.
  await prisma.$executeRaw`TRUNCATE TABLE audit_logs`;
  await prisma.approval.deleteMany();
  await prisma.weeklySubmission.deleteMany();
  await prisma.lockedPeriod.deleteMany();
  await prisma.timeEntry.deleteMany();
  await prisma.task.deleteMany();
  await prisma.project.deleteMany();
  await prisma.user.deleteMany({ where: { managerId: { not: null } } });
  await prisma.user.deleteMany();
}

/** The `name=value` pairs of every Set-Cookie header on a response, by cookie name. */
export function setCookies(res: { headers: Record<string, unknown> }): Record<string, string> {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? (raw as string[]) : [];
  return Object.fromEntries(
    list.map((line) => {
      const pair = line.split(';')[0] ?? '';
      const eq = pair.indexOf('=');
      return [pair.slice(0, eq), pair.slice(eq + 1)];
    }),
  );
}

/** The `Cookie` request-header value that carries a login's access token (test env: cookie `at`). */
export function accessCookie(res: { headers: Record<string, unknown> }): string {
  const value = setCookies(res)['at'];
  if (!value) throw new Error('no access cookie in response');
  return `at=${value}`;
}

/** Logs in with the shared test password and returns the `Cookie` header value for later calls. */
export async function loginToken(app: Express, email: string): Promise<string> {
  const res = await request(app).post('/api/auth/login').send({ email, password: TEST_PASSWORD });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status}`);
  return accessCookie(res);
}

export async function createProjectWithTask(
  prisma: PrismaClient,
  data: { code: string; taskName?: string; budgetHours?: number; startDate?: Date; endDate?: Date },
) {
  const project = await prisma.project.create({
    data: {
      code: data.code,
      name: `Project ${data.code}`,
      budgetHours: data.budgetHours ?? 100,
      ...(data.startDate && { startDate: data.startDate }),
      ...(data.endDate && { endDate: data.endDate }),
    },
  });
  const task = await prisma.task.create({
    data: { projectId: project.id, name: data.taskName ?? 'Build' },
  });
  return { project, task };
}

export const date = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

export { createTestPrisma };
