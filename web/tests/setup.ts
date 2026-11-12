import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { setCsrfToken, setUnauthorizedHandler } from '../src/lib/apiClient';

afterEach(() => {
  cleanup();
  setCsrfToken(null);
  setUnauthorizedHandler(null);
  vi.restoreAllMocks();
});
