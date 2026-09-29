'use strict';
const crypto = require('crypto');
const config = require('./config');
const store = require('./store');
const { now, uuid } = require('./util');

const MAX_LOG = 200;

function sign(secret, body, ts) {
  const sig = crypto.createHmac('sha256', Buffer.from(secret, 'utf8')).update(Buffer.from(`${ts}.${body}`, 'utf8')).digest('hex');
  return `t=${ts},v1=${sig}`;
}

function subscribers(eventName) {
  return Object.values(store.db().webhooks).filter((w) => !w.event_names || w.event_names.length === 0 || w.event_names.includes(eventName));
}

/**
 * Build the envelope Eka sends and deliver it to every matching subscription.
 * Fire-and-forget: API responses never wait on webhook delivery (same as production).
 */
function emit(eventName, data, { service } = {}) {
  const d = store.db();
  const t = now();
  const payload = {
    service: service || eventName.split('.')[0],
    event: eventName,
    transaction_id: data.appointment_id || data.prescription_id || data.id || uuid(),
    event_time: t,
    timestamp: t,
    client_id: config.clientId,
    business_id: d.business.business_id,
    data,
  };
  const subs = subscribers(eventName);
  for (const sub of subs) deliver(sub, payload);
  return { payload, delivered_to: subs.map((s) => s.id) };
}

async function deliver(sub, payload) {
  const body = JSON.stringify(payload);
  const headers = { 'Content-Type': 'application/json', 'User-Agent': 'Eka-Sandbox-Webhooks/1.0' };
  if (sub.signing_key) headers['Eka-Webhook-Signature'] = sign(sub.signing_key, body, now());
  const entry = {
    id: uuid(), webhook_id: sub.id, endpoint: sub.endpoint, event: payload.event, sent_at: new Date().toISOString(),
    request: { headers, body: payload }, response_status: null, error: null, duration_ms: null,
  };
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.webhookTimeoutMs);
  try {
    const res = await fetch(sub.endpoint, { method: 'POST', headers, body, signal: ctrl.signal });
    entry.response_status = res.status;
    entry.response_body = (await res.text()).slice(0, 2000);
  } catch (e) {
    entry.error = e.name === 'AbortError' ? `timeout after ${config.webhookTimeoutMs}ms` : e.message;
  } finally {
    clearTimeout(timer);
    entry.duration_ms = Date.now() - started;
  }
  const log = store.db().deliveries;
  log.unshift(entry);
  if (log.length > MAX_LOG) log.length = MAX_LOG;
  store.save();
  if (config.logRequests) {
    console.log(`[webhook] ${payload.event} -> ${sub.endpoint} : ${entry.response_status || entry.error}`);
  }
}

module.exports = { emit, sign };
