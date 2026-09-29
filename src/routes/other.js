'use strict';
const config = require('../config');
const store = require('../store');
const { E, HttpError } = require('../router');
const M = require('../models');
const { uuid } = require('../util');

function register(r) {
  // ================= Prescription =================
  r.add('GET', '/dr/v1/prescription/:prescription_id', ({ params }) => {
    const rx = store.db().prescriptions[params.prescription_id];
    if (!rx) throw E.err(404, 'PRESCRIPTION_NOT_FOUND', `Prescription ${params.prescription_id} not found`);
    return M.prescriptionDetail(rx);
  });

  // ================= Payments =================
  r.add('GET', '/dr/v1/payment/transaction_status/:transaction_id', ({ params }) => {
    const tx = store.db().transactions[params.transaction_id];
    if (!tx) throw new HttpError(404, { code: 'TRANSACTION_ID_NOT_FOUND', message: 'The specified transaction ID does not exist' });
    return tx;
  });

  // ================= IPD =================
  r.add('POST', '/appointments/v1/ipd/admission', ({ body }) => {
    const b = body || {};
    if (!b.patient || typeof b.patient !== 'object') throw E.err(400, 'INVALID_REQUEST', 'patient is required');
    const d = store.db();
    const ts = new Date().toISOString();
    const adm = {
      ...b,
      id: `adm-${uuid()}`,
      bid: d.business.business_id,
      admission_date: b.admission_date || ts,
      stage: b.stage || 'AD',
      status: b.status || 'BED_ASSIGNED',
      created_at: ts,
      updated_at: ts,
      totalbilled: 0,
      totalpaid: 0,
      actor_oid: 'sandbox-operator',
      archived: false,
    };
    d.admissions[adm.id] = adm;
    store.save();
    return { status: 201, body: adm };
  });

  r.add('GET', '/appointments/v1/ipd/admission/:admission_id', ({ params }) => {
    const adm = store.db().admissions[params.admission_id];
    if (!adm) throw E.err(404, 'NOT_FOUND', `Admission ${params.admission_id} was not found`);
    return adm;
  });

  // ================= Notify =================
  r.add('POST', '/notification/v1/notify', ({ body }) => {
    const p = body && body.partner_payload;
    const bad = (message) => new HttpError(400, { status: 'error', message });
    if (!p) throw bad('partner_payload is required');
    if (!p.partner_doctor_id) throw bad('partner_payload.partner_doctor_id is required');
    if (!store.findDoctor(p.partner_doctor_id)) throw bad(`Unknown partner_doctor_id ${p.partner_doctor_id}`);
    if (!p.message || !p.message.title || !p.message.body) throw bad('partner_payload.message.title and message.body are required');
    if (!['h', 'q', 'p', 'w'].includes(p.landing_page)) throw bad('partner_payload.landing_page must be one of h, q, p, w');
    if (['q', 'w'].includes(p.landing_page) && !p.params) throw bad(`partner_payload.params is required when landing_page is "${p.landing_page}"`);
    const log = store.db().notifications;
    log.unshift({ id: uuid(), received_at: new Date().toISOString(), partner_payload: p });
    if (log.length > 200) log.length = 200;
    store.save();
    return { status: 'success', message: 'Notification sent successfully.' };
  });

  // ================= Webhook subscriptions =================
  const WH = '/notification/v1/connect/webhook/subscriptions';

  r.add('POST', WH, ({ body }) => {
    const b = body || {};
    if (!b.endpoint) throw E.err(400, 'INVALID_REQUEST', 'endpoint is required');
    try { new URL(b.endpoint); } catch (e) { throw E.err(400, 'INVALID_REQUEST', 'endpoint must be a valid URL'); }
    const d = store.db();
    if (Object.values(d.webhooks).some((w) => w.endpoint === b.endpoint)) throw E.err(400, 'INVALID_REQUEST', 'requested endpoint is already registered');
    if (b.event_names !== undefined && !Array.isArray(b.event_names)) throw E.err(400, 'INVALID_REQUEST', 'event_names must be an array');
    d.webhookSeq += 1;
    const id = String(d.webhookSeq);
    const ts = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    d.webhooks[id] = {
      id, event_names: b.event_names || [], endpoint: b.endpoint, signing_key: b.signing_key || '', client_id: config.clientId,
      protocol: b.protocol || (b.endpoint.startsWith('https') ? 'https' : 'http'), business_id: d.business.business_id,
      created_at: ts, updated_at: ts, created_by: config.clientId, updated_by: config.clientId,
    };
    store.save();
    return { status: 201, body: { id, status: 'success' } };
  });

  r.add('GET', WH, () => ({ data: Object.values(store.db().webhooks), msg: 'success' }));

  r.add('DELETE', `${WH}/:id`, ({ params }) => {
    const d = store.db();
    if (!d.webhooks[params.id]) throw E.err(404, 'NOT_FOUND', 'Webhook not found');
    delete d.webhooks[params.id];
    store.save();
    return { status: 'webhook deleted successfully', msg: 'success' };
  });
}

module.exports = register;
