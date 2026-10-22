'use strict';
const http = require('http');
const config = require('./config');
const store = require('./store');
const { Router, HttpError, E, authenticate } = require('./router');
const requestLog = require('./requestlog');

function buildRouter() {
  const r = new Router();
  require('./routes/auth')(r);
  require('./routes/patients')(r);
  require('./routes/entities')(r);
  require('./routes/appointments')(r);
  require('./routes/schedules')(r);
  require('./routes/other')(r);
  require('./routes/sandbox')(r);
  return r;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'auth,authorization,client-id,content-type,time-zone,x-sandbox-force-status,x-sandbox-client',
};

function send(res, status, body, extraHeaders = {}) {
  const headers = { ...CORS, 'X-Eka-Sandbox': 'true', ...extraHeaders };
  if (status === 204 || body === undefined) {
    res.writeHead(status, headers);
    return res.end();
  }
  const payload = JSON.stringify(body);
  res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 5 * 1024 * 1024) { reject(E.err(413, 'PAYLOAD_TOO_LARGE', 'Body exceeds 5 MB')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(E.err(400, 'INVALID_JSON', `Request body is not valid JSON: ${e.message}`)); }
    });
    req.on('error', reject);
  });
}

function isEnvelope(r) {
  return r && typeof r === 'object' && typeof r.status === 'number' && ('body' in r || 'html' in r || Object.keys(r).length === 1);
}

function createServer() {
  store.load();
  const router = buildRouter();

  return http.createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname.replace(/\/{2,}/g, '/');
    let status = 500;
    let route = null;
    let reqBody;
    let resBody;
    const reply = (st, b, headers) => { status = st; resBody = b; return send(res, st, b, headers); };
    // API calls (not the portal, its assets or /_sandbox controls) go to the request log
    const logged = req.method !== 'OPTIONS' && !pathname.startsWith('/_sandbox') && pathname !== '/' && pathname !== '/favicon.ico';
    try {
      if (req.method === 'OPTIONS') { status = 204; return send(res, 204); }

      const m = router.match(req.method, pathname);
      route = m.route;
      const { params, pathMatched } = m;
      if (!route) {
        status = pathMatched ? 405 : 404;
        return reply(status, pathMatched
          ? { error: { code: 'METHOD_NOT_ALLOWED', message: `${req.method} is not supported on ${pathname}` } }
          : { error: { code: 'NOT_FOUND', message: `No sandbox route for ${req.method} ${pathname}. See GET /_sandbox/info or the README for supported endpoints.` } });
      }

      const isApi = !pathname.startsWith('/_sandbox') && pathname !== '/';
      const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? await readBody(req) : {};
      reqBody = Object.keys(body).length ? body : undefined;
      if (isApi && config.latencyMs) await new Promise((r) => setTimeout(r, config.latencyMs));

      const forced = Number(req.headers['x-sandbox-force-status']);
      if (isApi && forced >= 400 && forced < 600) {
        return reply(forced, { error: { code: 'SANDBOX_FORCED_ERROR', message: `Forced ${forced} via x-sandbox-force-status header` } });
      }

      const auth = route.auth ? authenticate(req) : null;
      if (route.clientIdHeader && !req.headers['client-id']) {
        throw new HttpError(400, { error: { message: 'client-id header is required', code: 'invalid_request' } });
      }
      const query = Object.fromEntries(url.searchParams.entries());
      const result = await route.handler({ req, params, query, body, auth });

      if (isEnvelope(result)) {
        status = result.status;
        if (result.html !== undefined) {
          res.writeHead(status, { 'Content-Type': result.contentType || 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          return res.end(result.html);
        }
        return reply(status, result.body, result.headers);
      }
      return reply(200, result);
    } catch (err) {
      if (err instanceof HttpError) return reply(err.status, err.body);
      console.error(err);
      return reply(500, { error: { code: 'SERVER_ERROR', message: `Sandbox internal error: ${err.message}` } });
    } finally {
      if (logged) {
        requestLog.add({
          method: req.method, path: pathname, query: url.search, route: route ? `${route.method} ${route.pattern}` : null, status,
          ms: Date.now() - started, reqHeaders: req.headers, reqBody, resBody,
        });
      }
      // Terminal log: API calls and sandbox actions, not the page's own polling and asset requests
      if (config.logRequests && (logged || (pathname.startsWith('/_sandbox') && req.method !== 'GET'))) {
        console.log(`${new Date().toISOString()} ${req.method} ${pathname}${url.search} -> ${status} (${Date.now() - started}ms)`);
      }
    }
  });
}

module.exports = { createServer, buildRouter };
