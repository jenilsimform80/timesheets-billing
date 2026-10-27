import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { dbDown, dbUp, fail, healthOk, mockApi, renderRoutes } from './helpers';

const section = (name: string) => within(screen.getByRole('region', { name }));

describe('StatusPage (API connectivity)', () => {
  it('shows loading, then the API and database as healthy', async () => {
    mockApi({ 'GET /health': healthOk(), 'GET /health/db': dbUp() });

    renderRoutes('/status');

    expect(screen.getAllByRole('status')).toHaveLength(2);
    expect(await section('API').findByText('Operational')).toBeInTheDocument();
    expect(section('API').getByText(/up 42s/)).toBeInTheDocument();
    expect(await section('Database').findByText('Connected')).toBeInTheDocument();
  });

  it('calls the API (same origin, credentials included for the cookies) through the configured base path', async () => {
    const { fetchMock } = mockApi({ 'GET /health': healthOk(), 'GET /health/db': dbUp() });

    renderRoutes('/status');
    await screen.findByText('Connected');

    const urls = fetchMock.mock.calls
      .map(([url]) => url as string)
      .filter((u) => u.includes('/health'))
      .sort();
    expect(urls).toEqual(['/api/health', '/api/health/db']);
    for (const [, init] of fetchMock.mock.calls) expect(init?.credentials).toBe('include');
  });

  it('shows "database unavailable" as a state of the system, not as a failed request', async () => {
    mockApi({ 'GET /health': healthOk(), 'GET /health/db': dbDown() });

    renderRoutes('/status');

    expect(await section('Database').findByText('Unavailable')).toBeInTheDocument();
    expect(section('Database').queryByRole('alert')).not.toBeInTheDocument();
    expect(section('API').getByText('Operational')).toBeInTheDocument();
  });

  it('shows an error with retry when the API cannot be reached, and recovers on retry', async () => {
    let up = false;
    mockApi({
      'GET /health': () => {
        if (!up) throw new TypeError('Failed to fetch');
        return healthOk();
      },
      'GET /health/db': dbUp(),
    });

    renderRoutes('/status');

    const alert = await section('API').findByRole('alert');
    expect(alert).toHaveTextContent('API unreachable');
    expect(alert).toHaveTextContent('Could not reach the server');
    expect(alert).not.toHaveTextContent('Failed to fetch');

    up = true;
    await userEvent.click(within(alert).getByRole('button', { name: 'Try again' }));

    expect(await section('API').findByText('Operational')).toBeInTheDocument();
    expect(section('API').queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the backend message for an API error response', async () => {
    mockApi({
      'GET /health': fail(500, 'INTERNAL_ERROR', 'An unexpected error occurred'),
      'GET /health/db': dbUp(),
    });

    renderRoutes('/status');

    expect(await section('API').findByRole('alert')).toHaveTextContent(
      'An unexpected error occurred',
    );
    expect(await section('Database').findByText('Connected')).toBeInTheDocument();
  });

  it('Refresh re-checks both', async () => {
    const api = mockApi({ 'GET /health': healthOk(), 'GET /health/db': dbUp() });
    renderRoutes('/status');
    await screen.findByText('Connected');
    expect(api.calls('GET /health')).toHaveLength(1);

    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    await waitFor(() => expect(api.calls('GET /health')).toHaveLength(2));
    expect(api.calls('GET /health/db')).toHaveLength(2);
    expect(await screen.findByText('Connected')).toBeInTheDocument();
  });
});
