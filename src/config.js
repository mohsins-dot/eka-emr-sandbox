'use strict';
const path = require('path');

const env = process.env;

module.exports = {
  port: Number(env.PORT || 4010),
  // Unset = all interfaces, IPv4 and IPv6, so `localhost` works whether it resolves to 127.0.0.1 or ::1.
  host: env.HOST || undefined,

  // Sandbox credentials handed to integrators. Change freely; they only work against this sandbox.
  clientId: env.EKA_SANDBOX_CLIENT_ID || 'EC_SANDBOX_001',
  clientSecret: env.EKA_SANDBOX_CLIENT_SECRET || 'sandbox_secret_do_not_use_in_prod',
  // Long-lived key accepted directly in the `auth` header (mirrors the long-lived token option).
  apiKey: env.EKA_SANDBOX_API_KEY || 'sandbox_long_lived_api_key',

  jwtSecret: env.EKA_SANDBOX_JWT_SECRET || 'eka-sandbox-local-signing-secret',
  accessTtl: Number(env.ACCESS_TOKEN_TTL || 1800), // 30 min, same as production guidance
  refreshTtl: Number(env.REFRESH_TOKEN_TTL || 86400 * 7),

  // Persistence: state is written to this file so it survives restarts. Set PERSIST=false for pure in-memory.
  persist: (env.PERSIST || 'true') !== 'false',
  dataFile: env.DATA_FILE || path.join(__dirname, '..', 'data', 'db.json'),

  // Artificial latency (ms) added to every API response, to test timeouts/loading states.
  latencyMs: Number(env.LATENCY_MS || 0),

  // Webhook delivery
  webhookTimeoutMs: Number(env.WEBHOOK_TIMEOUT_MS || 5000),

  // Clinic working hours used to generate appointment slots (IST).
  slotMinutes: Number(env.SLOT_MINUTES || 15),
  sessions: (env.CLINIC_SESSIONS || '09:00-13:00,17:00-20:00').split(',').map((s) => {
    const [a, b] = s.split('-');
    const [ah, am] = a.split(':').map(Number);
    const [bh, bm] = b.split(':').map(Number);
    return { start: ah * 60 + am, end: bh * 60 + bm };
  }),
  closedWeekdays: (env.CLOSED_WEEKDAYS || '0').split(',').filter(Boolean).map(Number), // 0 = Sunday

  logRequests: (env.LOG_REQUESTS || 'true') !== 'false',
};
