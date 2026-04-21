// Routable mock for global fetch. Match a request by URL substring + method
// and return a canned Response. Falls through to a 500 if nothing matches so
// missing routes are loud.

import { vi } from 'vitest';

export function makeMockFetch() {
  const routes = [];

  const fn = vi.fn(async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    const route = routes.find((r) => r.method === method && url.includes(r.match));
    if (!route) {
      return makeResponse(500, JSON.stringify({ error: `mock-fetch: no route for ${method} ${url}` }));
    }
    const result = typeof route.respond === 'function'
      ? await route.respond(url, init)
      : route.respond;
    if (result instanceof Response) return result;
    if (typeof result === 'object' && 'status' in result && 'body' in result) {
      return makeResponse(result.status, result.body, result.headers);
    }
    return makeResponse(200, typeof result === 'string' ? result : JSON.stringify(result));
  });

  fn.route = (method, match, respond) => {
    routes.push({ method: method.toUpperCase(), match, respond });
    return fn;
  };
  fn.calls = () => fn.mock.calls;
  fn.reset = () => { routes.length = 0; fn.mockClear(); };
  return fn;
}

function makeResponse(status, body, headers = {}) {
  const finalHeaders = new Headers(headers);
  if (!finalHeaders.has('content-type')) {
    const looksJson = typeof body === 'string' && (body.startsWith('{') || body.startsWith('['));
    finalHeaders.set('content-type', looksJson ? 'application/json' : 'text/plain');
  }
  // 204/205/304 must have a null body per the Fetch spec; undici throws otherwise.
  const safeBody = (status === 204 || status === 205 || status === 304) ? null : body;
  return new Response(safeBody, { status, headers: finalHeaders });
}
