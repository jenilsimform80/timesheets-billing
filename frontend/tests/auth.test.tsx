import { screen, waitFor, within } from '@testing-library/react';
import { useEffect, useState } from 'react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { apiRequest } from '../src/api/client';
import { RequireAuth } from '../src/auth/RequireAuth';
import { LoginPage } from '../src/pages/LoginPage';
import { routes } from '../src/routes';
import { safeReturnPath } from '../src/lib/navigation';
import {
  dbUp,
  fail,
  healthOk,
  dashboardApi,
  mockApi,
  noContent,
  ok,
  renderRoutes,
  signedInAs,
  tokenResponse,
  users,
} from './helpers';

const nav = () => within(screen.getByRole('navigation', { name: 'Main' }));
const linkNames = () =>
  nav()
    .getAllByRole('link')
    .map((l) => l.textContent);

describe('session bootstrap and route guards', () => {
  it('shows a loading state while the session is being checked, then the page', async () => {
    mockApi(signedInAs(users.contributor));

    renderRoutes('/');

    expect(screen.getByRole('status')).toHaveTextContent('Checking your session…');
    expect(
      await screen.findByRole('heading', { name: /Welcome, Casey Contributor/ }),
    ).toBeInTheDocument();
  });

  it('after a reload with an expired access cookie, renews the session silently instead of asking to sign in', async () => {
    let refreshed = false;
    const api = mockApi({
      ...dashboardApi(),
      'GET /auth/me': () =>
        refreshed
          ? ok({ user: users.contributor })
          : fail(401, 'UNAUTHENTICATED', 'Authentication required'),
      'POST /auth/refresh': () => {
        refreshed = true;
        return tokenResponse(users.contributor);
      },
    });

    renderRoutes('/');

    expect(
      await screen.findByRole('heading', { name: /Welcome, Casey Contributor/ }),
    ).toBeInTheDocument();
    expect(api.calls('POST /auth/refresh')).toHaveLength(1);
    expect(api.calls('POST /auth/refresh')[0]!.body).toBeUndefined(); // the cookie carries the token
  });

  it('redirects an anonymous visitor to /login and remembers where they wanted to go', async () => {
    mockApi(); // /auth/me -> 401

    const { router } = renderRoutes('/');

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
    expect(router.state.location.state).toEqual({ from: '/' });
  });

  it('treats a failing session check as signed out (never a blank screen)', async () => {
    mockApi({ 'GET /auth/me': fail(500, 'INTERNAL_ERROR', 'An unexpected error occurred') });

    renderRoutes('/');

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('keeps the public status page reachable without signing in', async () => {
    mockApi({ 'GET /health': healthOk(), 'GET /health/db': dbUp() });

    renderRoutes('/status');

    expect(await screen.findByText('Operational')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in' })).toBeInTheDocument();
  });
});

describe('login', () => {
  it('tells users who forgot their password to ask an admin', async () => {
    mockApi();
    renderRoutes('/login');

    expect(await screen.findByText(/Forgot your password\? Ask an admin/)).toBeInTheDocument();
  });

  it('lets the user reveal and re-hide the password, and signs in with what was typed', async () => {
    const api = mockApi({ 'POST /auth/login': tokenResponse(users.contributor) });
    renderRoutes('/login');
    await screen.findByRole('heading', { name: 'Sign in' });
    const password = screen.getByLabelText('Password');

    await userEvent.type(screen.getByLabelText('Email'), 'dev@example.com');
    await userEvent.type(password, 'S3cret-pass');
    expect(password).toHaveAttribute('type', 'password'); // hidden by default

    await userEvent.click(screen.getByRole('button', { name: 'Show password' }));
    expect(password).toHaveAttribute('type', 'text');
    expect(password).toHaveValue('S3cret-pass');
    expect(api.calls('POST /auth/login')).toHaveLength(0); // the eye button did not submit

    await userEvent.click(screen.getByRole('button', { name: 'Hide password' }));
    expect(password).toHaveAttribute('type', 'password');

    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('heading', { name: /Welcome, Casey Contributor/ });
    expect(api.calls('POST /auth/login')[0]!.body).toEqual({
      email: 'dev@example.com',
      password: 'S3cret-pass',
    });
  });

  it('signs in, sends the credentials once, and lands on the home page', async () => {
    const api = mockApi({ 'POST /auth/login': tokenResponse(users.contributor) });
    renderRoutes('/login');
    await screen.findByRole('heading', { name: 'Sign in' });

    await userEvent.type(screen.getByLabelText('Email'), '  dev@example.com ');
    await userEvent.type(screen.getByLabelText('Password'), 'S3cret-pass');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(
      await screen.findByRole('heading', { name: /Welcome, Casey Contributor/ }),
    ).toBeInTheDocument();
    expect(api.calls('POST /auth/login')).toHaveLength(1);
    expect(api.calls('POST /auth/login')[0]?.body).toEqual({
      email: 'dev@example.com',
      password: 'S3cret-pass',
    });
    expect(within(screen.getByRole('banner')).getByText(/Casey Contributor/)).toBeInTheDocument();
  });

  it('returns to the page the user originally asked for', async () => {
    mockApi({
      'POST /auth/login': tokenResponse(users.manager),
      'GET /health': healthOk(),
      'GET /health/db': dbUp(),
    });
    const { router } = renderRoutes('/login');
    await router.navigate('/login', { state: { from: '/status?x=1' } });
    await screen.findByRole('heading', { name: 'Sign in' });

    await userEvent.type(screen.getByLabelText('Email'), 'manager@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'pw');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/status'));
    expect(router.state.location.search).toBe('?x=1');
  });

  it('validates required fields on the client without calling the API', async () => {
    const api = mockApi();
    renderRoutes('/login');
    await screen.findByRole('heading', { name: 'Sign in' });

    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(screen.getByText('Enter your email')).toBeInTheDocument();
    expect(screen.getByText('Enter your password')).toBeInTheDocument();
    expect(api.calls('POST /auth/login')).toHaveLength(0);
  });

  it('shows the generic backend message for wrong credentials and stays on the form', async () => {
    mockApi({ 'POST /auth/login': fail(401, 'UNAUTHENTICATED', 'Invalid email or password') });
    const { router } = renderRoutes('/login');
    await screen.findByRole('heading', { name: 'Sign in' });

    await userEvent.type(screen.getByLabelText('Email'), 'dev@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password');
    expect(router.state.location.pathname).toBe('/login');
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });

  it('explains throttling (429) and disables the button while signing in', async () => {
    let release!: () => void;
    mockApi({
      'POST /auth/login': () =>
        new Promise((resolve) => {
          release = () =>
            resolve(fail(429, 'RATE_LIMITED', 'Too many failed login attempts. Try again later.'));
        }),
    });
    renderRoutes('/login');
    await screen.findByRole('heading', { name: 'Sign in' });
    await userEvent.type(screen.getByLabelText('Email'), 'dev@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'x');

    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(screen.getByRole('button', { name: 'Signing in…' })).toBeDisabled();
    release();

    expect(await screen.findByRole('alert')).toHaveTextContent('Too many failed login attempts');
  });

  it('does not show the login form to someone who is already signed in', async () => {
    mockApi(signedInAs(users.admin));

    renderRoutes('/login');

    expect(await screen.findByRole('heading', { name: /Welcome, Alex Admin/ })).toBeInTheDocument();
  });
});

describe('safeReturnPath', () => {
  it('accepts in-app paths only', () => {
    expect(safeReturnPath('/projects?x=1')).toBe('/projects?x=1');
    expect(safeReturnPath('https://evil.test/')).toBe('/');
    expect(safeReturnPath('//evil.test')).toBe('/');
    expect(safeReturnPath('/login')).toBe('/');
    expect(safeReturnPath(undefined)).toBe('/');
    expect(safeReturnPath(42)).toBe('/');
  });
});

describe('role-aware navigation (a convenience; the backend enforces access)', () => {
  it.each([
    ['contributor', users.contributor, ['Home', 'Timesheet', 'Projects', 'Reports', 'Account']],
    [
      'manager',
      users.manager,
      ['Home', 'Timesheet', 'Approvals', 'Projects', 'Reports', 'Account'],
    ],
    [
      'admin',
      users.admin,
      [
        'Home',
        'Timesheet',
        'Approvals',
        'Projects',
        'Reports',
        'Budgets',
        'Users',
        'Locked periods',
        'Account',
      ],
    ],
  ])('shows the right links for a %s', async (_label, user, expected) => {
    mockApi(signedInAs(user));

    renderRoutes('/');
    await screen.findByRole('heading', { name: /Welcome/ });

    expect(linkNames()).toEqual(expected);
  });
});

describe('sign out and expired sessions', () => {
  it('signs out: calls the API, clears the user and goes back to the login page', async () => {
    const api = mockApi({
      ...signedInAs(users.contributor),
      ...dashboardApi(),
      'POST /auth/logout': noContent(),
    });
    renderRoutes('/');
    await screen.findByRole('heading', { name: /Welcome/ });

    await userEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(api.calls('POST /auth/logout')).toHaveLength(1);
    expect(screen.queryByText('Casey Contributor')).not.toBeInTheDocument();
  });

  it('after Sign out, the next sign-in starts at the dashboard, not the page the last user was on', async () => {
    // Admin is on /users, signs out; a contributor (who cannot open /users) then signs in.
    let current: typeof users.admin | typeof users.contributor | null = users.admin;
    mockApi({
      ...signedInAs(users.admin), // /auth/me is overridden below
      'GET /auth/me': () =>
        current ? ok({ user: current }) : fail(401, 'UNAUTHENTICATED', 'Authentication required'),
      'GET /users': ok({ users: [users.admin] }),
      'POST /auth/logout': () => {
        current = null;
        return noContent();
      },
      'POST /auth/login': () => {
        current = users.contributor;
        return tokenResponse(current);
      },
    });
    const { router } = renderRoutes('/users');
    await screen.findByRole('heading', { name: 'Users' });

    await userEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    await screen.findByRole('heading', { name: 'Sign in' });
    expect(router.state.location.state).toBeNull(); // nothing remembered after an explicit sign-out

    await userEvent.type(screen.getByLabelText('Email'), 'dev@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'Some-Password-1');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(
      await screen.findByRole('heading', { name: /Welcome, Casey Contributor/ }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/');
    expect(screen.queryByText("You don't have access to this page")).not.toBeInTheDocument();
  });

  it('still returns to the requested page when a signed-out visitor opens a deep link', async () => {
    mockApi(); // /auth/me -> 401: a fresh visit or an expired session, not a Sign out

    const { router } = renderRoutes('/projects?includeArchived=true');

    await screen.findByRole('heading', { name: 'Sign in' });
    expect(router.state.location.state).toEqual({ from: '/projects?includeArchived=true' });
  });

  it('stays signed in and says so when the server could not end the session', async () => {
    mockApi({
      ...signedInAs(users.contributor),
      ...dashboardApi(),
      'POST /auth/logout': fail(500, 'INTERNAL_ERROR', 'An unexpected error occurred'),
    });
    renderRoutes('/');
    await screen.findByRole('heading', { name: /Welcome/ });

    await userEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not sign out');
    expect(screen.getByRole('alert')).toHaveTextContent('You are still signed in');
    expect(screen.getByRole('heading', { name: /Welcome/ })).toBeInTheDocument();
  });

  it('a 401 from any later API call drops the user to the login page (central handler)', async () => {
    // A protected page that makes an API call on mount; the session has silently expired.
    function Probe() {
      const [done, setDone] = useState(false);
      useEffect(() => {
        apiRequest('/projects').catch(() => setDone(true));
      }, []);
      return <p>{done ? 'request failed' : 'requesting'}</p>;
    }
    mockApi({
      ...signedInAs(users.contributor),
      'GET /projects': fail(401, 'UNAUTHENTICATED', 'Authentication required'),
      // the silent refresh is tried first, and the session really is gone
      'POST /auth/refresh': fail(401, 'UNAUTHENTICATED', 'Invalid or expired refresh token'),
    });
    const [root] = routes;
    if (!root || root.index) throw new Error('expected a non-index root route');
    const { router } = renderRoutes('/guarded', [
      {
        ...root,
        children: [
          { path: 'login', element: <LoginPage /> },
          { element: <RequireAuth />, children: [{ path: 'guarded', element: <Probe /> }] },
        ],
      },
    ]);

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
    expect(router.state.location.state).toEqual({ from: '/guarded' });
  });
});
