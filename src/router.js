'use strict';
const config = require('./config');
const { verifyJwt } = require('./util');

class HttpError extends Error {
  constructor(status, body) {
    super(typeof body === 'string' ? body : JSON.stringify(body));
    this.status = status;
    this.body = body;
  }
}

/** Common error body shapes used across Eka APIs */
const E = {
  // Appointment / generic dr APIs: { error: { code, message } }
  err: (status, code, message) => new HttpError(status, { error: { code, message } }),
  // cdr onboarding APIs: { status: 'error', message }
  cdr: (status, message, errors) => new HttpError(status, { status: 'error', message, ...(errors ? { errors } : {}) }),
  // auth APIs: { code, error }
  auth: (status, error) => new HttpError(status, { code: status, error }),
};

class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler, opts = {}) {
    const keys = [];
    const re = new RegExp(
      '^' + pattern.replace(/\/+$/, '').replace(/:([A-Za-z_]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$'
    );
    this.routes.push({ method, pattern, re, keys, handler, auth: opts.auth !== false, clientIdHeader: !!opts.clientIdHeader });
  }

  match(method, pathname) {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { route: r, params };
    }
    return { route: null, pathMatched };
  }
}

/** Accepts `auth: <token>`, `Authorization: Bearer <token>`, or the long-lived sandbox API key. */
function authenticate(req) {
  let token = req.headers['auth'];
  if (!token && req.headers['authorization']) token = String(req.headers['authorization']).replace(/^Bearer\s+/i, '');
  if (!token) throw E.auth(401, 'unauthenticated: send the access token in the `auth` header (or `Authorization: Bearer <token>`)');
  token = String(token).replace(/^Bearer\s+/i, '').trim();
  if (token === config.apiKey) return { b_id: null, client_id: config.clientId, type: 'api_key' };
  const v = verifyJwt(token, config.jwtSecret);
  if (!v.ok) throw E.auth(401, v.reason === 'token expired' ? 'token expired, call /connect-auth/v1/account/refresh-token' : `invalid token: ${v.reason}`);
  if (v.payload.typ !== 'access') throw E.auth(401, 'invalid token: a refresh token cannot be used to call APIs');
  return v.payload;
}

module.exports = { Router, HttpError, E, authenticate };
