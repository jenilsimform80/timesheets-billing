import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { assertNoUnmatchedRequests } from './helpers';

afterEach(() => {
  cleanup();
  assertNoUnmatchedRequests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
