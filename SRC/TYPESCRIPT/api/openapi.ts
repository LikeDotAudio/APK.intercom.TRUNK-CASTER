/**
 * Generate `openapi.json` (OpenAPI 3.1 catalogue) from routes.ts.
 *
 *   node --experimental-strip-types api/openapi.ts > api/openapi.json
 *
 * Schemas are by name: each response/request points at the TypeScript type in
 * types.ts (`x-ts-type`) and lists the top-level keys the smoke check
 * requires. types.ts stays the source of truth; this is the index.
 */
import { COMMON_ERRORS, GET_META, POST_META, WS_META, type Check, type RouteMeta } from './routes.ts';

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function toOpenApiPath(p: string): string {
  return p.replace(/:([A-Za-z_]\w*)/g, '{$1}');
}

function schemaFor(name: string, check: Check | undefined): Json {
  const s: { [k: string]: Json } = { 'x-ts-type': name };
  if (!check) return s;
  if (check.type === 'string') s['type'] = 'string';
  else if (check.type === 'object') {
    s['type'] = 'object';
    s['required'] = [...check.keys];
  } else if (check.type === 'array') {
    s['type'] = 'array';
    s['items'] = check.itemKeys ? { type: 'object', required: [...check.itemKeys] } : {};
  } else {
    s['type'] = 'object';
    s['additionalProperties'] = check.valueKeys ? { type: 'object', required: [...check.valueKeys] } : true;
  }
  return s;
}

function contentType(m: RouteMeta): string {
  if (m.response.includes('text/html')) return 'text/html; charset=utf-8';
  if (m.response.includes('text/markdown')) return 'text/markdown; charset=utf-8';
  if (m.response.includes('text/plain')) return 'text/plain; charset=utf-8';
  if (m.response.includes('audio/wav')) return 'audio/wav';
  return 'application/json; charset=utf-8';
}

function operation(method: string, path: string, m: RouteMeta): Json {
  const responses: { [k: string]: Json } = {
    '200': { description: 'OK', content: { [contentType(m)]: { schema: schemaFor(m.response, m.check) } } },
  };
  for (const e of [...(m.errors ?? []), ...COMMON_ERRORS.filter((c) => (method === 'get' ? c.status === 404 : false))]) {
    const key = String(e.status);
    const prev = responses[key];
    const desc = prev && typeof prev === 'object' && !Array.isArray(prev) && typeof prev['description'] === 'string' ? `${prev['description']}; ${e.when}` : e.when;
    responses[key] = { description: desc, content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } };
  }
  const params: Json[] = [];
  for (const [, name] of path.matchAll(/:([A-Za-z_]\w*)/g)) {
    params.push({ name: name ?? '', in: 'path', required: true, schema: { type: 'string' }, description: 'Taken verbatim from the path; NOT percent-decoded by the server.' });
  }
  for (const q of m.query ?? []) params.push({ name: q, in: 'query', required: false, schema: { type: 'string' } });
  const op: { [k: string]: Json } = {
    summary: m.summary,
    'x-source': `RUST-RUNTIME/src/http.rs:${m.line}`,
    responses,
  };
  if (params.length) op['parameters'] = params;
  if (m.aliasOf) op['x-alias-of'] = m.aliasOf;
  if (m.persists) op['x-persists'] = true;
  if (m.request) {
    op['requestBody'] = {
      required: true,
      description: 'Server ignores Content-Type and parses the body as JSON.',
      content: { 'application/json': { schema: { 'x-ts-type': m.request } } },
    };
  }
  return op;
}

export function buildOpenApi(): Json {
  const paths: { [k: string]: { [k: string]: Json } } = {};
  const add = (method: string, path: string, m: RouteMeta) => {
    const key = toOpenApiPath(path);
    (paths[key] ??= {})[method] = operation(method, path, m);
  };
  for (const [p, m] of Object.entries(GET_META)) add('get', p, m);
  for (const [p, m] of Object.entries(POST_META)) add('post', p, m);
  paths[WS_META.path] = {
    get: {
      summary: WS_META.summary,
      'x-source': `RUST-RUNTIME/src/http.rs:${WS_META.line}`,
      'x-websocket-messages': [...WS_META.messages],
      'x-ts-module': 'api/telemetry.ts',
      responses: {
        '101': { description: 'Switching Protocols' },
        '400': { description: 'no Sec-WebSocket-Key header', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
      },
    },
  };
  return {
    openapi: '3.1.0',
    info: {
      title: 'Trunk-Caster runtime HTTP API',
      version: '1',
      description:
        'Generated from TYPESCRIPT/api/routes.ts. Every response carries Cache-Control: no-store, Access-Control-Allow-Origin: *, Connection: close. Non-GET methods on any path without a handler return 405 (so OPTIONS preflight fails). Request bodies are capped at 4 MiB.',
    },
    servers: [{ url: 'http://127.0.0.1:8080' }],
    paths,
    components: {
      schemas: {
        ApiError: { type: 'object', required: ['error'], properties: { error: { type: 'string' } } },
      },
    },
  };
}

const isMain = typeof process !== 'undefined' && process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop() ?? '');
if (isMain) process.stdout.write(JSON.stringify(buildOpenApi(), null, 2) + '\n');
