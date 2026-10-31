// fetch wrapper: GET without a body, POST JSON with one. The answer is parsed
// as JSON when it parses, else returned as the raw text; HTTP status is not
// checked (a 400 `{error}` resolves like a 200).

/**
 * What a call can resolve to. `T` is the documented success shape and is an
 * unchecked cast: the server may also answer `ApiError` or plain text, so
 * callers that care narrow with `typeof r === 'string'` / `'error' in r`.
 */
export type ApiResult<T> = T | string;

export async function api<T = unknown>(path: string, body?: unknown): Promise<ApiResult<T>> {
  const r = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const t = await r.text();
  try {
    return JSON.parse(t) as T;
  } catch {
    return t;
  }
}
