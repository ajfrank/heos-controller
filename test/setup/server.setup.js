// Server-side setup. Suppress console.warn during tests; routes/heos log warnings
// for expected error paths and we don't want them muddying test output. Tests that
// need to assert on log output can spy on console themselves.
import { vi, beforeEach } from 'vitest';

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
