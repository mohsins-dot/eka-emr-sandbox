'use strict';
const config = require('../config');
const store = require('../store');
const { E } = require('../router');
const M = require('../models');
const webhooks = require('../webhooks');
const { createFromDr } = require('./patients');
const { schedulesFor, resolveDay } = require('../schedule');
const { uuid, now, istEpoch, istIso, istDate, isValidDate, daysBetween, addDays, splitMobile, dobFromAge } = require('../util');

const MODES = ['INCLINIC', 'PHONE', 'VIDEO'];
const RESCHEDULABLE = ['BK', 'OG', 'PA'];
const ACTIVE = ['BK', 'OG'];
// Statuses that still hold the doctor's time
const HOLDS_SLOT = ['BK', 'OG', 'PA'];

function newAppointmentId() {
  return `api-${uuid()}`;
}

function badReq(message) {
  return E.err(400, 'INVALID_REQUEST_PARAMETERS', message);
}

function notFound(id) {
  return E.err(404, 'APPOINTMENT_NOT_FOUND', `The specified appointment ID ${id} does not exist`);
}

function checkEpoch(v, name) {
  if (v === undefined || v === null) return;
  if (!Number.isInteger(v)) throw badReq(`${name} must be an integer epoch in seconds`);
  if (v > 1e12) throw badReq(`${name} looks like milliseconds (${v}); send epoch seconds`);
}

function bookingsAt(doctorId, s, e) {
  return Object.values(store.db().appointments).filter((a) => a.doctor_id === doctorId && HOLDS_SLOT.includes(a.status) && a.start_time < e && a.end_time > s).length;
}

/** Change status, persist and emit webhooks. */
function setStatus(a, status, action) {
  a.status = status;
  a.modified_at = now();
  if (status === 'OG') a.visit_start = a.modified_at;
  if (['CM', 'CMNP'].includes(status)) a.visit_end = a.modified_at;
  store.save();
  webhooks.emit('appointment.updated', M.appointmentEvent(a, action), { service: 'appointment' });
  webhooks.emit('appointment.statuschange', M.appointmentEvent(a, action), { service: 'appointment' });
}

function applyPatientDetails(patient, pd) {
  if (!pd || !patient) return;
  const map = { designation: 's', first_name: 'fn', middle_name: 'mn', last_name: 'ln', gender: 'gen', dob: 'dob' };
  for (const [k, v] of Object.entries(map)) if (pd[k] !== undefined) patient[v] = pd[k];
  if (pd.age !== undefined && pd.dob === undefined) { patient.dob = dobFromAge(pd.age); patient.is_age = true; }
  if (pd.mobile !== undefined) Object.assign(patient, splitMobile(pd.mobile));
  if (pd.address !== undefined) patient.address = { ...(patient.address || {}), ...pd.address };
  patient.fln = [patient.fn, patient.mn, patient.ln].filter(Boolean).join(' ');
  patient.u_ate = now();
}

function resolvePatient(b) {
  const pd = b.patient_details;
  const pid = b.patient_id || b.partner_patient_id || (pd && pd.partner_patient_id);
  if (pid) {
    const p = store.findPatient(pid);
    if (p) return p;
    if (b.patient_id && !pd) throw E.err(404, 'PATIENT_NOT_FOUND', `Patient ${b.patient_id} not found`);
  }
  if (!pd) throw badReq('Provide patient_id / partner_patient_id of an existing patient, or patient_details to register a new one');
  return createFromDr({ ...pd, partner_patient_id: b.partner_patient_id || pd.partner_patient_id });
}

function register(r) {
  // ---------- Get appointment slots ----------
  r.add('GET', '/dr/v1/doctor/:doctor_id/clinic/:clinic_id/appointment/slot', ({ params, query }) => {
    const slotErr = (status, message) => ({ status, body: { success: 'false', status_code: status, message } });
    const doc = store.findDoctor(params.doctor_id);
    if (!doc) return slotErr(404, 'Doctor not found. Please check the provided doctor ID.');
    const clinic = store.findClinic(params.clinic_id);
    if (!clinic) return slotErr(404, 'Clinic not found. Please check the provided clinic ID.');
    if (!doc.clinic_ids.includes(clinic.id)) return slotErr(400, `Doctor ${doc.id} does not practice at clinic ${clinic.id}.`);
    const { start_date, end_date } = query;
    if (!isValidDate(start_date) || !isValidDate(end_date)) return slotErr(400, 'start_date and end_date are required in YYYY-MM-DD format.');
    const span = daysBetween(start_date, end_date);
    if (span < 0) return slotErr(400, 'end_date cannot be before start_date.');
    if (span > 30) return slotErr(400, 'Date range cannot exceed 30 days in the sandbox.');

    const svcs = (store.db().services[doc.id] || []).filter((s) => !s.archive);
    const primary = svcs.find((s) => s.mode.includes('in-clinic')) || svcs[0];
    // Slots come from the doctor's product-widget schedule at this clinic; doctors without one use CLINIC_SESSIONS.
    const sched = schedulesFor(doc.id, clinic.id, 'product-widget')[0];
    const limit = sched ? sched.config.overbooking_limit : 1;
    const svcById = Object.fromEntries(svcs.map((x) => [x.conf_id, x]));
    const t = now();
    const slots = [];
    const push = (s, e, confId) => slots.push({ available: s > t && bookingsAt(doc.id, s, e) < limit, conf_id: confId, s: istIso(s), e: istIso(e) });
    for (let i = 0; i <= span; i++) {
      const date = addDays(start_date, i);
      if (sched) {
        for (const w of resolveDay(sched, date).windows) {
          const slicers = sched.config.schedule_slot_config_enabled
            ? [{ conf_id: primary ? primary.conf_id : null, minutes: sched.config.slot_durations[0] }]
            : w.conf_ids.map((id) => svcById[id]).filter(Boolean).map((x) => ({ conf_id: x.conf_id, minutes: x.duration || config.slotMinutes }));
          for (const c of slicers) {
            for (let s = w.s; s + c.minutes * 60 <= w.e; s += c.minutes * 60) push(s, s + c.minutes * 60, c.conf_id);
          }
        }
        continue;
      }
      if (config.closedWeekdays.includes(new Date(date + 'T00:00:00Z').getUTCDay())) continue;
      for (const sess of config.sessions) {
        for (let m = sess.start; m + config.slotMinutes <= sess.end; m += config.slotMinutes) {
          const s = istEpoch(date, Math.floor(m / 60), m % 60);
          push(s, s + config.slotMinutes * 60, primary ? primary.conf_id : null);
        }
      }
    }
    slots.sort((x, y) => x.s.localeCompare(y.s));
    const services = {};
    for (const s of svcs) {
      services[s.conf_id] = {
        allow_patient_booking: s.allow_patient_booking, appointment_type: s.appointment_type, conf_id: s.conf_id, conv_fee: s.conv_fee,
        currency: s.currency, discount: s.discount, mode: s.mode, owner_id: doc.id, post_pay: s.post_pay, pre_pay: s.pre_pay,
        price: s.price, service_id: s.service_id, service_name: s.service_name,
      };
    }
    return { data: { schedule: { [clinic.id]: { service_type: primary ? primary.service_name : 'consultation', slots } }, services }, success: 'true', status_code: 200 };
  });

  // ---------- Book appointment ----------
  r.add('POST', '/dr/v1/appointment', ({ body }) => {
    const b = body || {};
    const ad = b.appointment_details || {};
    if (!b.doctor_id && !b.partner_doctor_id) throw badReq('doctor_id or partner_doctor_id is required');
    if (!b.clinic_id && !b.partner_clinic_id) throw badReq('clinic_id or partner_clinic_id is required');
    if (ad.start_time === undefined) throw badReq('appointment_details.start_time is required');
    checkEpoch(ad.start_time, 'appointment_details.start_time');
    checkEpoch(ad.end_time, 'appointment_details.end_time');
    if (ad.end_time !== undefined && ad.end_time < ad.start_time) throw badReq('appointment_details.end_time must be after start_time');
    const mode = (ad.mode || 'INCLINIC').toUpperCase();
    if (!MODES.includes(mode)) throw badReq(`appointment_details.mode must be one of ${MODES.join(', ')}`);

    const doc = store.findDoctor(b.doctor_id || b.partner_doctor_id);
    if (!doc) throw E.err(404, 'DOCTOR_NOT_FOUND', `Doctor ${b.doctor_id || b.partner_doctor_id} not found`);
    const clinic = store.findClinic(b.clinic_id || b.partner_clinic_id);
    if (!clinic) throw E.err(404, 'CLINIC_NOT_FOUND', `Clinic ${b.clinic_id || b.partner_clinic_id} not found`);
    if (!doc.clinic_ids.includes(clinic.id)) throw badReq(`Doctor ${doc.id} does not practice at clinic ${clinic.id}`);

    const d = store.db();
    if (b.partner_appointment_id && Object.values(d.appointments).some((a) => a.partner_appointment_id === String(b.partner_appointment_id))) {
      throw E.err(409, 'APPOINTMENT_ALREADY_EXISTS', `Appointment with partner_appointment_id ${b.partner_appointment_id} already exists`);
    }
    const patient = resolvePatient(b);

    const svcs = d.services[doc.id] || [];
    const svc = svcs.find((s) => s.conf_id === ad.conf_id) || svcs.find((s) => (mode === 'INCLINIC' ? s.mode.includes('in-clinic') : !s.mode.includes('in-clinic'))) || svcs[0];
    const start = ad.start_time;
    const end = ad.end_time || start + (svc ? svc.duration : config.slotMinutes) * 60;
    const sameDay = Object.values(d.appointments).filter((a) => a.doctor_id === doc.id && a.clinic_id === clinic.id && istDate(a.start_time) === istDate(start));
    const t = now();
    const a = {
      appointment_id: newAppointmentId(), partner_appointment_id: b.partner_appointment_id ? String(b.partner_appointment_id) : null,
      doctor_id: doc.id, clinic_id: clinic.id, patient_id: patient.oid, status: 'BK', mode, channel: 'API',
      token: b.token ?? sameDay.length + 1, start_time: start, end_time: end, created_at: t, modified_at: t,
      conf_id: svc ? svc.conf_id : null, prescription_id: null, custom_attributes: ad.custom_attributes || {},
      video_connect: ad.video_connect, partner_meta: b.partner_meta || {}, display_meta: b.display_meta || {}, notes: b.notes || '',
      payment: { payment_id: null, payment_status: null, amount: null }, prev_aids: [],
    };
    d.appointments[a.appointment_id] = a;
    store.save();
    webhooks.emit('appointment.created', M.appointmentEvent(a, 'created'), { service: 'appointment' });
    return { status: 201, body: { appointment_id: a.appointment_id } };
  });

  // ---------- List appointments ----------
  r.add('GET', '/dr/v1/appointment', ({ query }) => {
    const { patient_id, doctor_id, clinic_id, start_date, end_date } = query;
    const page = Math.max(0, Number(query.page_no) || 0);
    let list = Object.values(store.db().appointments);
    let limit;
    if (patient_id) {
      if (doctor_id || clinic_id || start_date || end_date) throw badReq('patient_id must be used on its own (no doctor_id, clinic_id or dates)');
      const p = store.findPatient(patient_id, { includeArchived: true });
      const pid = p ? p.oid : patient_id;
      list = list.filter((a) => a.patient_id === pid);
      limit = 20;
    } else {
      if (!start_date || !end_date) throw badReq('start_date and end_date are required unless filtering by patient_id alone');
      if (!isValidDate(start_date) || !isValidDate(end_date)) throw badReq('start_date and end_date must be YYYY-MM-DD');
      const span = daysBetween(start_date, end_date);
      if (span < 0) throw badReq('end_date cannot precede start_date');
      if (span > 7) throw badReq('Date range cannot exceed 7 days');
      list = list.filter((a) => { const dt = istDate(a.start_time); return dt >= start_date && dt <= end_date; });
      if (doctor_id) { const doc = store.findDoctor(doctor_id); list = list.filter((a) => a.doctor_id === (doc ? doc.id : doctor_id)); }
      if (clinic_id) { const c = store.findClinic(clinic_id); list = list.filter((a) => a.clinic_id === (c ? c.id : clinic_id)); }
      limit = doctor_id || clinic_id ? 50 : 30;
    }
    list.sort((x, y) => x.start_time - y.start_time || x.created_at - y.created_at);
    return { appointments: list.slice(page * limit, (page + 1) * limit).map(M.appointmentSummary) };
  });

  // ---------- Get appointment ----------
  r.add('GET', '/dr/v1/appointment/:appointment_id', ({ params, query }) => {
    const a = store.findAppointment(params.appointment_id, query.partner_id);
    if (!a) throw E.err(404, 'NOT_FOUND', 'Appointment not found. Please check the provided appointment ID.');
    return M.appointmentDetail(a);
  });

  // ---------- Update appointment (v1) ----------
  r.add('PATCH', '/dr/v1/appointment/:appointment_id', ({ params, query, body }) => {
    const a = store.findAppointment(params.appointment_id, query.partner_id);
    if (!a) throw notFound(params.appointment_id);
    const b = body || {};
    checkEpoch(b.start_time, 'start_time');
    checkEpoch(b.end_time, 'end_time');
    const s = b.start_time ?? a.start_time;
    const e = b.end_time ?? (b.start_time !== undefined ? s + (a.end_time - a.start_time) : a.end_time);
    if (e < s) throw E.err(400, 'INVALID_REQUEST', 'end_time must be after start_time');
    a.start_time = s; a.end_time = e;
    if (b.token !== undefined) a.token = b.token;
    if (b.custom_attributes !== undefined) a.custom_attributes = b.custom_attributes;
    if (b.partner_meta !== undefined) a.partner_meta = b.partner_meta;
    if (b.display_meta !== undefined) a.display_meta = b.display_meta;
    if (b.video_connect !== undefined) a.video_connect = { ...(a.video_connect || {}), ...b.video_connect };
    if (b.notes !== undefined) a.notes = b.notes;
    applyPatientDetails(store.db().patients[a.patient_id], b.patient_details);
    a.modified_at = now();
    store.save();
    webhooks.emit('appointment.updated', M.appointmentEvent(a, 'modified'), { service: 'appointment' });
    return { status: 204 };
  });

  // ---------- Update appointment (v2) ----------
  r.add('PATCH', '/dr/v2/appointment/:appointment_id', ({ params, query, body }) => {
    const a = store.findAppointment(params.appointment_id, query.partner_id);
    if (!a) throw notFound(params.appointment_id);
    const b = body || {};
    const ad = b.appointment_details || {};
    checkEpoch(ad.start_time, 'appointment_details.start_time');
    checkEpoch(ad.end_time, 'appointment_details.end_time');
    if (ad.mode !== undefined && !MODES.includes(String(ad.mode).toUpperCase())) throw E.err(400, 'INVALID_REQUEST', `appointment_details.mode must be one of ${MODES.join(', ')}`);
    const docKey = b.doctor_id || b.partner_doctor_id;
    const clinicKey = b.clinic_id || b.partner_clinic_id;
    const doc = docKey ? store.findDoctor(docKey) : store.db().doctors[a.doctor_id];
    const clinic = clinicKey ? store.findClinic(clinicKey) : store.db().clinics[a.clinic_id];
    if (!doc) throw E.err(400, 'INVALID_REQUEST', `Doctor ${docKey} not found`);
    if (!clinic) throw E.err(400, 'INVALID_REQUEST', `Clinic ${clinicKey} not found`);
    if (!doc.clinic_ids.includes(clinic.id)) throw E.err(400, 'INVALID_REQUEST', `Doctor ${doc.id} does not practice at clinic ${clinic.id}`);
    const s = ad.start_time ?? a.start_time;
    const e = ad.end_time ?? (ad.start_time !== undefined ? s + (a.end_time - a.start_time) : a.end_time);
    if (e < s) throw E.err(400, 'INVALID_REQUEST', 'end_time must be after start_time');
    a.doctor_id = doc.id; a.clinic_id = clinic.id; a.start_time = s; a.end_time = e;
    if (ad.mode !== undefined) a.mode = String(ad.mode).toUpperCase();
    if (ad.custom_attributes !== undefined) a.custom_attributes = ad.custom_attributes;
    if (ad.video_connect !== undefined) a.video_connect = ad.video_connect;
    if (b.token !== undefined) a.token = b.token;
    if (b.partner_meta !== undefined) a.partner_meta = b.partner_meta; // fully overwritten, as documented
    if (b.display_meta !== undefined) a.display_meta = b.display_meta;
    if (b.notes !== undefined) a.notes = b.notes;
    applyPatientDetails(store.db().patients[a.patient_id], b.patient_details);
    a.modified_at = now();
    store.save();
    webhooks.emit('appointment.updated', M.appointmentEvent(a, 'modified'), { service: 'appointment' });
    return { status: 204 };
  });

  // ---------- Cancel ----------
  r.add('PUT', '/dr/v1/appointment/:appointment_id/cancel', ({ params, query }) => {
    const a = store.findAppointment(params.appointment_id, query.partner_id);
    if (!a) throw notFound(params.appointment_id);
    if (a.status === 'CN') throw E.err(403, 'CANCEL_NOT_ALLOWED', 'Appointment is already cancelled');
    if (a.status === 'RES') throw E.err(403, 'CANCEL_NOT_ALLOWED', `Appointment was rescheduled to ${a.next_aid}; cancel that one instead`);
    if (['CM', 'CMNP'].includes(a.status)) throw E.err(403, 'CANCEL_NOT_ALLOWED', 'A completed appointment cannot be cancelled');
    setStatus(a, 'CN', 'cancelled');
    return { status: 204 };
  });

  // ---------- Complete ----------
  r.add('POST', '/dr/v1/appointment/:appointment_id/complete', ({ params, query }) => {
    const a = store.findAppointment(params.appointment_id, query.partner_id);
    if (!a) throw notFound(params.appointment_id);
    if (['CN', 'NS', 'RES'].includes(a.status)) throw E.err(403, 'COMPLETE_NOT_ALLOWED', `An appointment in status ${a.status} cannot be completed`);
    if (['CM', 'CMNP'].includes(a.status)) return { status: 204 };
    setStatus(a, a.prescription_id ? 'CM' : 'CMNP', 'completed');
    return { status: 204 };
  });

  // ---------- Park ----------
  r.add('POST', '/dr/v1/appointment/:appointment_id/parked', ({ params, query }) => {
    const a = store.findAppointment(params.appointment_id, query.partner_id);
    if (!a) throw notFound(params.appointment_id);
    if (!ACTIVE.includes(a.status)) throw E.err(403, 'COMPLETE_NOT_ALLOWED', `An appointment in status ${a.status} cannot be parked`);
    setStatus(a, 'PA', 'parked');
    return { status: 204 };
  });

  // ---------- No-show ----------
  r.add('POST', '/dr/v1/appointment/:appointment_id/change-status', ({ params, query, body }) => {
    const a = store.findAppointment(params.appointment_id, query.partner_id);
    if (!a) throw notFound(params.appointment_id);
    const status = body && body.status;
    if (status !== 'NS') throw E.err(400, 'INVALID_REQUEST', 'status must be "NS" (no-show)');
    if (!['BK', 'PA'].includes(a.status)) throw E.err(400, 'INVALID_REQUEST', `Cannot mark an appointment in status ${a.status} as no-show`);
    setStatus(a, 'NS', 'no_show');
    return { status: 200, body: { status: 'success', appointment_id: a.appointment_id, appointment_status: 'NS' } };
  });

  // ---------- Confirm follow-up ----------
  r.add('PUT', '/dr/v1/appointment/:appointment_id/follow-up/confirm', ({ params, query, body }) => {
    const a = store.findAppointment(params.appointment_id, query.partner_id);
    if (!a) throw notFound(params.appointment_id);
    const b = body || {};
    if (b.start_time === undefined || b.end_time === undefined) throw E.err(400, 'INVALID_REQUEST', 'start_time and end_time are required');
    checkEpoch(b.start_time, 'start_time');
    checkEpoch(b.end_time, 'end_time');
    if (b.end_time < b.start_time) throw E.err(400, 'INVALID_REQUEST', 'end_time must be after start_time');
    a.start_time = b.start_time; a.end_time = b.end_time; a.follow_up_confirmed = true;
    setStatus(a, 'BK', 'follow_up_confirmed');
    return { status: 204 };
  });

  // ---------- Reschedule in place (v1) ----------
  r.add('PUT', '/dr/v1/appointment/:appointment_id/reschedule', ({ params, query, body }) => {
    const a = store.findAppointment(params.appointment_id, query.partner_id);
    if (!a) throw notFound(params.appointment_id);
    const b = body || {};
    if (b.start_time === undefined || b.end_time === undefined) throw E.err(400, 'INVALID_REQUEST', 'start_time and end_time are required');
    checkEpoch(b.start_time, 'start_time');
    checkEpoch(b.end_time, 'end_time');
    if (b.end_time <= b.start_time) throw E.err(400, 'INVALID_REQUEST', 'end_time must be after start_time');
    if (!['BK', 'PA'].includes(a.status)) throw E.err(403, 'RESCHEDULE_NOT_ALLOWED', `An appointment in status ${a.status} cannot be rescheduled`);
    const docKey = b.doc_id || b.partner_doctor_id;
    const clinicKey = b.clinic_id || b.partner_clinic_id;
    const doc = docKey ? store.findDoctor(docKey) : store.db().doctors[a.doctor_id];
    const clinic = clinicKey ? store.findClinic(clinicKey) : store.db().clinics[a.clinic_id];
    if (!doc) throw E.err(400, 'INVALID_REQUEST', `Doctor ${docKey} not found`);
    if (!clinic) throw E.err(400, 'INVALID_REQUEST', `Clinic ${clinicKey} not found`);
    if (!doc.clinic_ids.includes(clinic.id)) throw E.err(400, 'INVALID_REQUEST', `Doctor ${doc.id} does not practice at clinic ${clinic.id}`);
    a.doctor_id = doc.id; a.clinic_id = clinic.id; a.start_time = b.start_time; a.end_time = b.end_time;
    a.status = 'BK';
    a.modified_at = now();
    store.save();
    webhooks.emit('appointment.updated', M.appointmentEvent(a, 'modified'), { service: 'appointment' });
    return { status: 204 };
  });

  // ---------- Update custom attributes ----------
  r.add('PATCH', '/dr/v1/appointment/:appointment_id/custom_attribute', ({ params, query, body }) => {
    const a = store.findAppointment(params.appointment_id, query.partner_id);
    if (!a) throw notFound(params.appointment_id);
    const b = body;
    if (!b || typeof b !== 'object' || Array.isArray(b) || !Object.keys(b).length) throw E.err(400, 'INVALID_REQUEST', 'Body must be an object of custom attributes, e.g. {"payment_status": ["paid"]}');
    a.custom_attributes = { ...(a.custom_attributes || {}), ...b };
    a.modified_at = now();
    store.save();
    webhooks.emit('appointment.updated', M.appointmentEvent(a, 'modified'), { service: 'appointment' });
    return { status: 204 };
  });

  // ---------- All appointments for a patient ----------
  r.add('GET', '/dr/v1/appointment/patient/:patient_id', ({ params }) => {
    const p = store.findPatient(params.patient_id, { includeArchived: true });
    const pid = p ? p.oid : params.patient_id;
    const list = Object.values(store.db().appointments).filter((a) => a.patient_id === pid).sort((x, y) => y.start_time - x.start_time);
    return { success: true, data: list.map(M.patientAppointment) };
  });

  // ---------- Reschedule ----------
  // Creates a new appointment; the old one becomes RES and points at it via next_aid.
  r.add('PATCH', '/appointments/v1/:appointment_id/reschedule', ({ params, body }) => {
    const b = body || {};
    const old = store.findAppointment(params.appointment_id, b.partner_appointment_id ? '1' : undefined) || store.findAppointment(params.appointment_id);
    if (!old) throw E.err(404, 'NOT_FOUND', `Appointment ${params.appointment_id} was not found`);
    if (b.start_time === undefined || b.end_time === undefined) throw E.err(400, 'INVALID_REQUEST', 'start_time and end_time are required');
    checkEpoch(b.start_time, 'start_time');
    checkEpoch(b.end_time, 'end_time');
    if (b.end_time <= b.start_time) throw E.err(400, 'INVALID_REQUEST', 'end_time must be after start_time');
    if (!RESCHEDULABLE.includes(old.status)) throw E.err(400, 'INVALID_REQUEST', `An appointment in status ${old.status} cannot be rescheduled`);
    const d = store.db();
    if (b.partner_appointment_id && Object.values(d.appointments).some((x) => x.appointment_id !== old.appointment_id && x.partner_appointment_id === String(b.partner_appointment_id))) {
      throw E.err(409, 'CONFLICT', `Appointment ${b.partner_appointment_id} already exists`);
    }
    const t = now();
    const nu = {
      ...JSON.parse(JSON.stringify(old)),
      appointment_id: newAppointmentId(),
      partner_appointment_id: b.partner_appointment_id ? String(b.partner_appointment_id) : old.partner_appointment_id,
      status: 'BK', start_time: b.start_time, end_time: b.end_time, created_at: t, modified_at: t,
      prev_aids: [...(old.prev_aids || []), old.appointment_id], next_aid: undefined,
    };
    old.partner_appointment_id = old.partner_appointment_id ? `${old.partner_appointment_id}#rescheduled` : null;
    old.next_aid = nu.appointment_id;
    d.appointments[nu.appointment_id] = nu;
    setStatus(old, 'RES', 'rescheduled');
    webhooks.emit('appointment.created', M.appointmentEvent(nu, 'created'), { service: 'appointment' });
    return {
      appointment_id: nu.appointment_id, patient_id: nu.patient_id, doctor_id: nu.doctor_id, clinic_id: nu.clinic_id,
      status: nu.status, mode: nu.mode === 'INCLINIC' ? 'IN_CLINIC' : nu.mode, start_time: nu.start_time, end_time: nu.end_time,
      created_at: nu.created_at, prev_aids: nu.prev_aids,
    };
  });
}

module.exports = register;
module.exports.setStatus = setStatus;
