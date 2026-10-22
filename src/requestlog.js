'use strict';
/** In-memory log of API calls (not /_sandbox or the portal), shown live in the portal's Request log. */
const MAX = 300;
let entries = [];
let seq = 0;

const MASK = ['auth', 'authorization'];
const LIMIT = 20000;

function trim(v) {
  if (v === undefined) return undefined;
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s.length <= LIMIT) return v;
  return s.slice(0, LIMIT) + '… (truncated)';
}

function add({ method, path, query, route, status, ms, reqHeaders, reqBody, resBody }) {
  const headers = {};
  for (const [k, v] of Object.entries(reqHeaders || {})) {
    if (['host', 'connection', 'accept-encoding', 'content-length', 'sec-fetch-mode', 'sec-fetch-site', 'sec-fetch-dest', 'accept-language', 'origin', 'referer'].includes(k) || k.startsWith('sec-ch')) continue;
    headers[k] = MASK.includes(k) ? String(v).slice(0, 18) + '…' : v;
  }
  entries.unshift({
    id: ++seq, at: new Date().toISOString(), method, path, query, route, status, ms,
    source: reqHeaders['x-sandbox-client'] === 'console' ? 'console' : 'app',
    forced: !!reqHeaders['x-sandbox-force-status'],
    request: { headers, body: trim(reqBody) }, response: trim(resBody),
  });
  if (entries.length > MAX) entries.length = MAX;
}

function list(since = 0) {
  return { requests: entries.filter((e) => e.id > since), latest: seq };
}

function clear() {
  entries = [];
}

module.exports = { add, list, clear };
