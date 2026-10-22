'use strict';
/**
 * Sandbox-only control endpoints (NOT part of the Eka API). Everything lives under /_sandbox and needs no auth.
 * They let testers drive things that happen on the doctor's side in production (consult started, prescription
 * written, payment made) and inspect webhook traffic.
 */
const config = require('../config');
const store = require('../store');
const { E } = require('../router');
const M = require('../models');
const webhooks = require('../webhooks');
const { samplePrescription, IDS } = require('../seed');
const { setStatus } = require('./appointments');
const { signJwt, now, uuid, randDigits } = require('../util');
const dashboard = require('../dashboard');

function register(r) {
  const open = { auth: false };

  r.add('GET', '/', () => ({ status: 200, html: dashboard.render() }), open);

  r.add('GET', '/_sandbox/info', () => {
    const d = store.db();
    return {
      base_url: `http://localhost:${config.port}`,
      credentials: { client_id: config.clientId, client_secret: config.clientSecret, long_lived_api_key: config.apiKey },
      business: d.business,
      seeded_ids: IDS,
      doctors: Object.values(d.doctors).filter((x) => !x.deleted).map((x) => ({ id: x.id, partner_id: x.partner_id, name: `Dr. ${M.docName(x)}`, clinics: x.clinic_ids })),
      clinics: Object.values(d.clinics).filter((x) => !x.deleted).map((x) => ({ id: x.id, partner_id: x.partner_id, name: x.name })),
      patients: Object.values(d.patients).filter((x) => !x.arc).map((x) => ({ oid: x.oid, partner_patient_id: x.partner_patient_id, name: x.fln, mobile: `${x.ccd}${x.mobile}` })),
      transactions: Object.keys(d.transactions),
      // Codes the sandbox produces. Production also uses IN, AB, NSD, NSS, CND, CNS, PC, PNR, RE and RED (see README).
      appointment_status_codes: { BK: 'Booked', PA: 'Parked', OG: 'Ongoing', CM: 'Completed with prescription', CMNP: 'Completed without prescription', NS: 'No-show', CN: 'Cancelled', RES: 'Rescheduled (old appointment; see next_aid)' },
    };
  }, open);

  r.add('POST', '/_sandbox/reset', () => {
    store.reset();
    return { status: 'success', message: 'Sandbox data reset to seed state. Webhook subscriptions and tokens were cleared.' };
  }, open);

  r.add('GET', '/_sandbox/state', () => store.db(), open);

  // Issue an access token with a custom TTL (e.g. ?ttl=5) to test your 401 -> refresh flow quickly.
  r.add('POST', '/_sandbox/token', ({ query }) => {
    const ttl = Math.max(1, Number(query.ttl) || 5);
    const t = now();
    const access_token = signJwt({ b_id: store.db().business.business_id, client_id: config.clientId, iss: 'eka-sandbox', iat: t, typ: 'access', exp: t + ttl, jti: uuid() }, config.jwtSecret);
    return { access_token, expires_in: ttl };
  }, open);

  // Doctor starts the consultation -> OG
  r.add('POST', '/_sandbox/appointments/:appointment_id/start', ({ params }) => {
    const a = store.findAppointment(params.appointment_id);
    if (!a) throw E.err(404, 'APPOINTMENT_NOT_FOUND', 'Appointment not found');
    if (a.status !== 'BK') throw E.err(400, 'INVALID_REQUEST', `Only BK appointments can be started (current: ${a.status})`);
    setStatus(a, 'OG', 'started');
    return { status: 'success', appointment_id: a.appointment_id, appointment_status: a.status };
  }, open);

  // Doctor writes / edits the prescription -> CM + prescription.created|updated webhook
  r.add('POST', '/_sandbox/appointments/:appointment_id/prescription', ({ params, body }) => {
    const a = store.findAppointment(params.appointment_id);
    if (!a) throw E.err(404, 'APPOINTMENT_NOT_FOUND', 'Appointment not found');
    if (['CN', 'NS', 'RES'].includes(a.status)) throw E.err(400, 'INVALID_REQUEST', `Cannot write a prescription for an appointment in status ${a.status}`);
    const d = store.db();
    const t = now();
    let rx = a.prescription_id && d.prescriptions[a.prescription_id];
    let action;
    if (rx) {
      rx.previous_version = rx.current_version;
      rx.current_version = String(Number(rx.current_version) + 1);
      rx.modified_at = t;
      action = 'updated';
    } else {
      const id = `P-DW-${randDigits(13)}`;
      rx = samplePrescription({
        prescription_id: id, appointment: a, doctor: d.doctors[a.doctor_id], patient: d.patients[a.patient_id], clinic: d.clinics[a.clinic_id], created_at: t,
      });
      d.prescriptions[id] = rx;
      a.prescription_id = id;
      action = 'created';
    }
    if (body && Array.isArray(body.prescription_details)) rx.prescription_details = body.prescription_details;
    store.save();
    webhooks.emit(`prescription.${action}`, M.prescriptionEvent(rx, action), { service: 'prescription' });
    if (a.status !== 'CM') setStatus(a, 'CM', 'completed');
    return { status: 'success', prescription_id: rx.prescription_id, version: rx.current_version, appointment_status: a.status };
  }, open);

  // Patient pays for an appointment -> creates a transaction you can query with transaction_status
  r.add('POST', '/_sandbox/appointments/:appointment_id/payment', ({ params, body }) => {
    const a = store.findAppointment(params.appointment_id);
    if (!a) throw E.err(404, 'APPOINTMENT_NOT_FOUND', 'Appointment not found');
    const b = body || {};
    const status = b.payment_status || 'PAYMENT_SUCCESS';
    const svc = (store.db().services[a.doctor_id] || []).find((s) => s.conf_id === a.conf_id);
    const amount = b.amount ?? (svc ? svc.price : 500);
    const id = `txn-${uuid()}`;
    store.db().transactions[id] = {
      transaction_id: id, amount, created_at: new Date().toISOString().replace('Z', '+0000'), payment_gateway: 'Ezetap',
      payment_mode: b.payment_mode || 'UPI', payment_status: status, rrn: status === 'PAYMENT_SUCCESS' ? randDigits(7) : null,
    };
    a.payment = { payment_id: id, payment_status: status, amount };
    a.modified_at = now();
    store.save();
    return { status: 'success', transaction_id: id, payment_status: status, amount };
  }, open);

  // Fire any event on demand (uses the latest appointment / prescription as sample data)
  r.add('POST', '/_sandbox/webhooks/test', ({ body }) => {
    const event = (body && body.event) || 'appointment.created';
    const d = store.db();
    let data;
    if (event.startsWith('prescription.')) {
      const rx = Object.values(d.prescriptions).sort((x, y) => y.modified_at - x.modified_at)[0];
      data = M.prescriptionEvent(rx, event.split('.')[1]);
    } else {
      const a = Object.values(d.appointments).sort((x, y) => y.modified_at - x.modified_at)[0];
      data = M.appointmentEvent(a, event.split('.')[1] || 'created');
    }
    const out = webhooks.emit(event, data);
    return { status: 'success', event, delivered_to: out.delivered_to, payload: out.payload, note: out.delivered_to.length ? 'Check /_sandbox/webhooks/deliveries for results' : 'No subscription matches this event; register one first' };
  }, open);

  r.add('GET', '/_sandbox/webhooks/deliveries', () => ({ deliveries: store.db().deliveries }), open);

  // Built-in receiver so you can test webhooks without running your own server
  r.add('POST', '/_sandbox/webhook-receiver', ({ req, body }) => {
    const log = store.db().received;
    log.unshift({ received_at: new Date().toISOString(), signature: req.headers['eka-webhook-signature'] || null, body });
    if (log.length > 200) log.length = 200;
    store.save();
    return { ok: true };
  }, open);
  r.add('GET', '/_sandbox/webhook-receiver', () => ({ received: store.db().received }), open);

  r.add('GET', '/_sandbox/notifications', () => ({ notifications: store.db().notifications }), open);
}

module.exports = register;
