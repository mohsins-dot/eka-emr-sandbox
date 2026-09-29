'use strict';
const config = require('../config');
const store = require('../store');
const { E } = require('../router');
const { signJwt, verifyJwt, now, uuid } = require('../util');

function issue(clientId) {
  const d = store.db();
  const t = now();
  const base = { b_id: d.business.business_id, client_id: clientId, iss: 'eka-sandbox', iat: t };
  const access_token = signJwt({ ...base, typ: 'access', exp: t + config.accessTtl, jti: uuid() }, config.jwtSecret);
  const refreshJti = uuid();
  const refresh_token = signJwt({ ...base, typ: 'refresh', exp: t + config.refreshTtl, jti: refreshJti }, config.jwtSecret);
  d.refreshTokens[refreshJti] = { client_id: clientId, exp: t + config.refreshTtl, used: false };
  store.save();
  return { access_token, expires_in: config.accessTtl, refresh_expires_in: config.refreshTtl, refresh_token };
}

module.exports = function register(r) {
  // POST /connect-auth/v1/account/login
  r.add('POST', '/connect-auth/v1/account/login', ({ body }) => {
    const { client_id, client_secret } = body || {};
    if (!client_id || !client_secret) throw E.auth(400, 'client_id and client_secret are required');
    if (client_id !== config.clientId || client_secret !== config.clientSecret) throw E.auth(401, 'invalid client credentials');
    return issue(client_id);
  }, { auth: false });

  // POST /connect-auth/v1/account/refresh-token
  r.add('POST', '/connect-auth/v1/account/refresh-token', ({ body }) => {
    const { refresh_token } = body || {};
    if (!refresh_token) throw E.auth(400, 'refresh_token is required');
    const v = verifyJwt(refresh_token, config.jwtSecret);
    if (!v.ok) throw E.auth(401, `invalid refresh token: ${v.reason}`);
    if (v.payload.typ !== 'refresh') throw E.auth(401, 'invalid refresh token: not a refresh token');
    const d = store.db();
    const rec = d.refreshTokens[v.payload.jti];
    if (!rec) throw E.auth(401, 'invalid refresh token: unknown (was the sandbox reset?)');
    return issue(v.payload.client_id);
  }, { auth: false });
};
