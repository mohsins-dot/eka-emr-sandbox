'use strict';
/**
 * End-to-end smoke test: starts the sandbox in-memory on a spare port and exercises every route.
 * Run: npm test
 */
const { spawn } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const assert = require('assert');

const PORT = 4999;
const BASE = `http://localhost:${PORT}`;
let passed = 0;
const failures = [];

async function call(method, p, { body, headers = {}, token } = {}) {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (token) h.auth = token;
  const res = await fetch(BASE + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = text; }
  return { status: res.status, body: json };
}

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures.push({ name, e });
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function istToday() {
  return new Date(Date.now() + 19800000).toISOString().slice(0, 10);
}
function addDays(s, n) {
  const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), PERSIST: 'false', LOG_REQUESTS: 'false' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/_sandbox/info'); break; } catch (e) { await sleep(100); }
  }

  const info = (await call('GET', '/_sandbox/info')).body;
  const { client_id, client_secret, long_lived_api_key } = info.credentials;
  const DOC = info.seeded_ids.doctors.priya;
  const CLINIC = info.seeded_ids.clinics.bangalore;
  let T, R, patientId, apptId, rxId, whId;

  console.log('\nAuth');
  await test('login rejects bad secret', async () => {
    const r = await call('POST', '/connect-auth/v1/account/login', { body: { client_id, client_secret: 'nope' } });
    assert.strictEqual(r.status, 401);
  });
  await test('login returns tokens', async () => {
    const r = await call('POST', '/connect-auth/v1/account/login', { body: { client_id, client_secret } });
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.access_token && r.body.refresh_token && r.body.expires_in === 1800);
    T = r.body.access_token; R = r.body.refresh_token;
  });
  await test('refresh returns new tokens', async () => {
    const r = await call('POST', '/connect-auth/v1/account/refresh-token', { body: { refresh_token: R }, headers: { Authorization: `Bearer ${T}`, 'Client-Id': client_id } });
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.access_token);
    T = r.body.access_token;
  });
  await test('no token -> 401', async () => {
    assert.strictEqual((await call('GET', '/cdr/v1/doctor/')).status, 401);
  });
  await test('Authorization: Bearer works too', async () => {
    assert.strictEqual((await call('GET', '/cdr/v1/doctor/', { headers: { Authorization: `Bearer ${T}` } })).status, 200);
  });
  await test('long-lived api key works', async () => {
    assert.strictEqual((await call('GET', '/cdr/v1/get_business_info/', { token: long_lived_api_key })).status, 200);
  });
  await test('expired token -> 401', async () => {
    const short = (await call('POST', '/_sandbox/token?ttl=1')).body.access_token;
    await sleep(2100);
    const r = await call('GET', '/cdr/v1/doctor/', { token: short });
    assert.strictEqual(r.status, 401);
    assert.match(r.body.error, /expired/);
  });
  await test('forced error header', async () => {
    assert.strictEqual((await call('GET', '/cdr/v1/doctor/', { token: T, headers: { 'x-sandbox-force-status': '503' } })).status, 503);
  });

  console.log('\nBusiness, doctors, clinics');
  await test('business info', async () => {
    const r = await call('GET', '/cdr/v1/get_business_info/', { token: T });
    assert.strictEqual(r.body.status, 'success'); assert.ok(r.body.bid);
  });
  await test('business entities', async () => {
    const r = await call('GET', '/dr/v1/business/entities', { token: T });
    assert.strictEqual(r.body.data.doctors.length, 3); assert.strictEqual(r.body.data.clinics.length, 2);
  });
  await test('doctor profile', async () => {
    const r = await call('GET', `/dr/v1/doctor/${DOC}`, { token: T });
    assert.strictEqual(r.body.id, DOC); assert.ok(r.body.profile.professional.clinics.length);
  });
  await test('clinic details', async () => {
    const r = await call('GET', `/dr/v1/business/clinic/${CLINIC}`, { token: T });
    assert.strictEqual(r.body.data.clinic.clinic_id, CLINIC);
  });
  await test('doctor services', async () => {
    const r = await call('GET', `/dr/v1/doctor/service/${DOC}`, { token: T });
    assert.ok(r.body.data.services.length >= 1);
  });

  let newDoc, newClinic, newUser;
  await test('create clinic', async () => {
    const r = await call('POST', '/cdr/v1/clinic/', { token: T, body: { name: 'Test Clinic', address: '1 Test Road', pincode: '560001', contact: '9876543210', partner_id: 'TC-1', city: 'Bangalore', state: 'Karnataka' } });
    assert.strictEqual(r.status, 201); newClinic = r.body.ekaid;
  });
  await test('create doctor at clinic via partner ids', async () => {
    const r = await call('POST', '/cdr/v1/doctor/', { token: T, body: { firstname: 'Test', lastname: 'Doctor', gender: 'F', mobile: '9876500000', specialisations: ['Dermatologist'], partner_clinic_ids: ['TC-1'], partner_id: 'TD-1' } });
    assert.strictEqual(r.status, 201); newDoc = r.body.ekaid;
  });
  await test('create doctor validation (gender) -> 400', async () => {
    const r = await call('POST', '/cdr/v1/doctor/', { token: T, body: { firstname: 'X', lastname: 'Y', gender: 'Z' } });
    assert.strictEqual(r.status, 400);
  });
  await test('duplicate partner_id -> 400', async () => {
    const r = await call('POST', '/cdr/v1/doctor/', { token: T, body: { firstname: 'X', lastname: 'Y', gender: 'M', partner_id: 'TD-1' } });
    assert.strictEqual(r.status, 400);
  });
  await test('get doctor by partner id', async () => {
    const r = await call('GET', '/cdr/v1/doctor/TD-1/', { token: T });
    assert.strictEqual(r.body.doctor.id, newDoc); assert.strictEqual(r.body.doctor.clinics[0].id, newClinic);
  });
  await test('update doctor', async () => {
    const r = await call('PATCH', `/cdr/v1/doctor/${newDoc}/`, { token: T, body: { about: 'Updated' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await call('GET', `/cdr/v1/doctor/${newDoc}/`, { token: T })).body.doctor.about, 'Updated');
  });
  await test('clinic lists its doctor', async () => {
    const r = await call('GET', `/cdr/v1/clinic/${newClinic}/`, { token: T });
    assert.strictEqual(r.body.clinic.doctors[0].id, newDoc);
  });
  await test('list clinics / update clinic', async () => {
    assert.ok((await call('GET', '/cdr/v1/clinic/', { token: T })).body.clinics.length === 3);
    assert.strictEqual((await call('PATCH', `/cdr/v1/clinic/${newClinic}/`, { token: T, body: { name: 'Renamed' } })).status, 200);
  });
  await test('eka user CRUD', async () => {
    let r = await call('POST', '/cdr/v1/ekauser/', { token: T, body: { firstname: 'Nurse', lastname: 'One', gender: 'F', dob: '1990-01-01', email: 'n1@example.com', doctor_ids: [newDoc], clinic_ids: [newClinic] } });
    assert.strictEqual(r.status, 201); newUser = r.body.ekaid;
    r = await call('GET', `/cdr/v1/ekauser/${newUser}/`, { token: T }); assert.strictEqual(r.body.user.doctors[0].id, newDoc);
    r = await call('PATCH', `/cdr/v1/ekauser/${newUser}/`, { token: T, body: { is_admin: true } }); assert.strictEqual(r.status, 200);
    r = await call('GET', '/cdr/v1/hipusers/', { token: T }); assert.strictEqual(r.body.users.length, 2);
    r = await call('GET', `/cdr/v1/hipusers/${newUser}`, { token: T }); assert.strictEqual(r.body.user.is_admin, true);
    r = await call('DELETE', `/cdr/v1/ekauser/${newUser}/`, { token: T }); assert.strictEqual(r.status, 200);
  });
  await test('delete doctor and clinic', async () => {
    assert.strictEqual((await call('DELETE', `/cdr/v1/doctor/${newDoc}/`, { token: T })).body.message, 'Doctor Deleted Successfully');
    assert.strictEqual((await call('GET', `/cdr/v1/doctor/${newDoc}/`, { token: T })).status, 404);
    assert.strictEqual((await call('DELETE', `/cdr/v1/clinic/${newClinic}/`, { token: T })).body.message, 'Clinic Deleted Successfully');
  });

  console.log('\nPatients (/dr/v1)');
  await test('add patient', async () => {
    const r = await call('POST', '/dr/v1/patient', { token: T, body: { designation: 'Mr.', first_name: 'Test', last_name: 'Patient', gender: 'M', age: 34, mobile: '+918888800001', partner_patient_id: 'EXT-1', address: { city: 'Pune', pincode: '411001' } } });
    assert.strictEqual(r.status, 201); patientId = r.body.patient_id;
  });
  await test('duplicate partner_patient_id -> 409', async () => {
    const r = await call('POST', '/dr/v1/patient', { token: T, body: { first_name: 'A', gender: 'M', age: 3, partner_patient_id: 'EXT-1' } });
    assert.strictEqual(r.status, 409);
  });
  await test('missing gender -> 400', async () => {
    assert.strictEqual((await call('POST', '/dr/v1/patient', { token: T, body: { first_name: 'A', age: 3 } })).status, 400);
  });
  await test('get / update patient', async () => {
    let r = await call('GET', `/dr/v1/patient/${patientId}`, { token: T });
    assert.strictEqual(r.body.first_name, 'Test');
    r = await call('PATCH', '/dr/v1/patient/EXT-1?partner_id=1', { token: T, body: { last_name: 'Renamed', partner_meta: { mrn: 'M1' } } });
    assert.strictEqual(r.status, 201);
    r = await call('GET', `/dr/v1/patient/${patientId}`, { token: T });
    assert.strictEqual(r.body.last_name, 'Renamed'); assert.strictEqual(r.body.partner_meta.mrn, 'M1');
  });
  await test('search by mobile', async () => {
    const r = await call('GET', '/dr/v1/business/patients/search?mobile=9999900001', { token: T });
    assert.strictEqual(r.body.data.profiles.length, 2);
    assert.strictEqual((await call('GET', '/dr/v1/business/patients/search?mobile=1234567890', { token: T })).status, 404);
  });

  console.log('\nPatient directory (/profiles/v1)');
  let oid;
  const ph = { 'client-id': client_id };
  await test('client-id header required', async () => {
    assert.strictEqual((await call('GET', '/profiles/v1/patient/minified/?pageNo=1', { token: T })).status, 400);
  });
  await test('create profile', async () => {
    const r = await call('POST', '/profiles/v1/patient/', { token: T, headers: ph, body: { fn: 'Dir', ln: 'User', dob: '2000-01-02', gen: 'F', mobile: '+917777700001', username: 'DIR001', bloodgroup: 'A+' } });
    assert.strictEqual(r.status, 201); oid = r.body.oid;
  });
  await test('invalid gender enum', async () => {
    const r = await call('POST', '/profiles/v1/patient/', { token: T, headers: ph, body: { fn: 'X', dob: '2000-01-02', gen: 'X' } });
    assert.strictEqual(r.status, 400); assert.strictEqual(r.body.error.message, 'Invalid Gender Enum');
  });
  await test('retrieve / update profile', async () => {
    let r = await call('GET', `/profiles/v1/patient/${oid}`, { token: T, headers: ph });
    assert.strictEqual(r.body.fln, 'Dir User'); assert.strictEqual(r.body.bg, 'A+');
    r = await call('PATCH', `/profiles/v1/patient/${oid}`, { token: T, headers: ph, body: { fln: 'Dir Middle User' } });
    assert.strictEqual(r.body.message, 'Profile updated successfully');
    r = await call('GET', `/profiles/v1/patient/${oid}`, { token: T, headers: ph });
    assert.strictEqual(r.body.mn, 'Middle');
  });
  await test('search / by-mobile / username / list', async () => {
    assert.ok((await call('GET', '/profiles/v1/patient/search?prefix=dir', { token: T, headers: ph })).body.length === 1);
    assert.strictEqual((await call('GET', '/profiles/v1/patient/by-mobile/?mob=%2B917777700001', { token: T, headers: ph })).body.oid, oid);
    assert.strictEqual((await call('GET', '/profiles/v1/patient/DIR001/username/?flatten=true', { token: T, headers: ph })).body[0].oid, oid);
    const r = await call('GET', '/profiles/v1/patient/minified/?pageNo=1&pageSize=3&select=dob,gen', { token: T, headers: ph });
    assert.strictEqual(r.body.profiles.length, 3); assert.strictEqual(r.body.currPageMeta.nextPage, 2); assert.ok(r.body.profiles[0].dob);
  });
  await test('archive then permanently delete', async () => {
    assert.strictEqual((await call('DELETE', `/profiles/v1/patient/${oid}`, { token: T, headers: ph })).body.message, 'Profile archived successfully');
    assert.strictEqual((await call('GET', `/profiles/v1/patient/${oid}`, { token: T, headers: ph })).status, 404);
    assert.strictEqual((await call('GET', `/profiles/v1/patient/${oid}?arc=true`, { token: T, headers: ph })).status, 200);
    assert.strictEqual((await call('DELETE', `/profiles/v1/patient/${oid}?perm=true`, { token: T, headers: ph })).status, 200);
    assert.strictEqual((await call('GET', `/profiles/v1/patient/${oid}?arc=true`, { token: T, headers: ph })).status, 404);
  });

  console.log('\nWebhooks');
  const SIGNING = 'test-signing-key';
  await test('register webhook to built-in receiver', async () => {
    const r = await call('POST', '/notification/v1/connect/webhook/subscriptions', { token: T, body: { endpoint: `${BASE}/_sandbox/webhook-receiver`, event_names: ['appointment.created', 'appointment.updated', 'appointment.statuschange', 'prescription.created'], signing_key: SIGNING, protocol: 'http' } });
    assert.strictEqual(r.status, 201); whId = r.body.id;
  });
  await test('duplicate endpoint -> 400', async () => {
    const r = await call('POST', '/notification/v1/connect/webhook/subscriptions', { token: T, body: { endpoint: `${BASE}/_sandbox/webhook-receiver` } });
    assert.strictEqual(r.status, 400);
  });
  await test('list webhooks', async () => {
    assert.strictEqual((await call('GET', '/notification/v1/connect/webhook/subscriptions', { token: T })).body.data.length, 1);
  });

  console.log('\nAppointments');
  const day = (() => { let d = addDays(istToday(), 2); if (new Date(d + 'T00:00:00Z').getUTCDay() === 0) d = addDays(d, 1); return d; })();
  let slot;
  await test('get slots', async () => {
    const r = await call('GET', `/dr/v1/doctor/${DOC}/clinic/${CLINIC}/appointment/slot?start_date=${day}&end_date=${day}`, { token: T });
    assert.strictEqual(r.status, 200);
    const s = r.body.data.schedule[CLINIC].slots;
    assert.ok(s.length > 10);
    slot = s.find((x) => x.available);
    assert.ok(slot);
    assert.ok(r.body.data.services[slot.conf_id]);
  });
  await test('slots for unknown doctor -> 404', async () => {
    assert.strictEqual((await call('GET', `/dr/v1/doctor/000/clinic/${CLINIC}/appointment/slot?start_date=${day}&end_date=${day}`, { token: T })).status, 404);
  });
  const st = () => Math.floor(new Date(slot.s).getTime() / 1000);
  await test('book with partner ids + new patient_details', async () => {
    const r = await call('POST', '/dr/v1/appointment', { token: T, body: {
      partner_appointment_id: 'PA-TEST-1', partner_clinic_id: 'CL01', partner_doctor_id: 'test-doc-456', partner_patient_id: 'EXT-NEW-9',
      appointment_details: { start_time: st(), end_time: st() + 900, mode: 'INCLINIC', custom_attributes: { label: ['vitals_submitted'] } },
      patient_details: { designation: 'Ms.', first_name: 'Booked', last_name: 'Patient', mobile: '+919000011111', gender: 'F', dob: '1991-02-03' },
      partner_meta: { encounter_id: 'E1' }, notes: '<p>hi</p>',
    } });
    assert.strictEqual(r.status, 201); apptId = r.body.appointment_id; assert.match(apptId, /^api-/);
  });
  await test('booked slot now unavailable', async () => {
    const r = await call('GET', `/dr/v1/doctor/${DOC}/clinic/${CLINIC}/appointment/slot?start_date=${day}&end_date=${day}`, { token: T });
    assert.strictEqual(r.body.data.schedule[CLINIC].slots.find((x) => x.s === slot.s).available, false);
  });
  await test('duplicate partner_appointment_id -> 409', async () => {
    const r = await call('POST', '/dr/v1/appointment', { token: T, body: { partner_appointment_id: 'PA-TEST-1', clinic_id: CLINIC, doctor_id: DOC, patient_id: patientId, appointment_details: { start_time: st() + 3600 } } });
    assert.strictEqual(r.status, 409);
  });
  await test('millisecond epoch rejected', async () => {
    const r = await call('POST', '/dr/v1/appointment', { token: T, body: { clinic_id: CLINIC, doctor_id: DOC, patient_id: patientId, appointment_details: { start_time: st() * 1000 } } });
    assert.strictEqual(r.status, 400);
  });
  await test('get appointment by eka id and partner id', async () => {
    let r = await call('GET', `/dr/v1/appointment/${apptId}`, { token: T });
    assert.strictEqual(r.body.status, 'BK'); assert.strictEqual(r.body.partner_doctor_id, 'test-doc-456'); assert.strictEqual(r.body.partner_patient_id, 'EXT-NEW-9');
    r = await call('GET', '/dr/v1/appointment/PA-TEST-1?partner_id=1', { token: T });
    assert.strictEqual(r.body.appointment_id, apptId);
  });
  await test('list appointments by doctor + dates', async () => {
    const r = await call('GET', `/dr/v1/appointment?doctor_id=${DOC}&start_date=${day}&end_date=${day}`, { token: T });
    assert.ok(r.body.appointments.some((a) => a.appointment_id === apptId));
  });
  await test('list invalid combos -> 400', async () => {
    assert.strictEqual((await call('GET', `/dr/v1/appointment?doctor_id=${DOC}`, { token: T })).status, 400);
    assert.strictEqual((await call('GET', `/dr/v1/appointment?start_date=${day}&end_date=${addDays(day, 9)}`, { token: T })).status, 400);
  });
  await test('update v1 -> 204', async () => {
    const r = await call('PATCH', '/dr/v1/appointment/PA-TEST-1?partner_id=1', { token: T, body: { token: 7, display_meta: { room: '3' } } });
    assert.strictEqual(r.status, 204);
    assert.strictEqual((await call('GET', `/dr/v1/appointment/${apptId}`, { token: T })).body.token, 7);
  });
  await test('update v2 -> 204', async () => {
    const r = await call('PATCH', `/dr/v2/appointment/${apptId}`, { token: T, body: { appointment_details: { mode: 'VIDEO' }, partner_meta: { x: 1 } } });
    assert.strictEqual(r.status, 204);
    const g = (await call('GET', `/dr/v1/appointment/${apptId}`, { token: T })).body;
    assert.strictEqual(g.mode, 'video'); assert.deepStrictEqual(g.partner_meta, { x: 1 });
  });
  let newApptId;
  await test('reschedule creates new appointment', async () => {
    const r = await call('PATCH', `/appointments/v1/${apptId}/reschedule`, { token: T, body: { start_time: st() + 3600, end_time: st() + 4500 } });
    assert.strictEqual(r.status, 200); newApptId = r.body.appointment_id;
    assert.deepStrictEqual(r.body.prev_aids, [apptId]);
    const old = (await call('GET', `/dr/v1/appointment/${apptId}`, { token: T })).body;
    assert.strictEqual(old.status, 'RES'); assert.strictEqual(old.next_aid, newApptId);
    assert.strictEqual((await call('GET', '/dr/v1/appointment/PA-TEST-1?partner_id=1', { token: T })).body.appointment_id, newApptId);
  });
  await test('sandbox start -> OG, prescription -> CM', async () => {
    assert.strictEqual((await call('POST', `/_sandbox/appointments/${newApptId}/start`)).body.appointment_status, 'OG');
    const r = await call('POST', `/_sandbox/appointments/${newApptId}/prescription`);
    assert.strictEqual(r.body.appointment_status, 'CM'); rxId = r.body.prescription_id;
  });
  await test('get prescription', async () => {
    const r = await call('GET', `/dr/v1/prescription/${rxId}`, { token: T });
    assert.strictEqual(r.body.prescription_id, rxId);
    assert.ok(r.body.prescription_details.some((x) => x.resource_type === 'medicationrequest'));
    assert.ok((await call('GET', `/dr/v1/appointment/${newApptId}`, { token: T })).body.prescription_url);
  });
  await test('cancel completed -> 403', async () => {
    assert.strictEqual((await call('PUT', `/dr/v1/appointment/${newApptId}/cancel?partner_id=0`, { token: T })).status, 403);
  });
  await test('book, complete without Rx -> CMNP', async () => {
    const b = await call('POST', '/dr/v1/appointment', { token: T, body: { clinic_id: CLINIC, doctor_id: DOC, patient_id: patientId, appointment_details: { start_time: st() + 7200 } } });
    const id = b.body.appointment_id;
    assert.strictEqual((await call('POST', `/dr/v1/appointment/${id}/complete?partner_id=0`, { token: T })).status, 204);
    assert.strictEqual((await call('GET', `/dr/v1/appointment/${id}`, { token: T })).body.status, 'CMNP');
  });
  await test('book, no-show, park, cancel, follow-up', async () => {
    const mk = async (off) => (await call('POST', '/dr/v1/appointment', { token: T, body: { clinic_id: CLINIC, doctor_id: DOC, patient_id: patientId, appointment_details: { start_time: st() + off } } })).body.appointment_id;
    const a1 = await mk(10800), a2 = await mk(11700), a3 = await mk(12600);
    assert.strictEqual((await call('POST', `/dr/v1/appointment/${a1}/change-status?partner_id=0`, { token: T, body: { status: 'NS' } })).status, 200);
    assert.strictEqual((await call('POST', `/dr/v1/appointment/${a2}/parked?partner_id=0`, { token: T })).status, 204);
    assert.strictEqual((await call('GET', `/dr/v1/appointment/${a2}`, { token: T })).body.status, 'PA');
    assert.strictEqual((await call('PUT', `/dr/v1/appointment/${a3}/cancel?partner_id=0`, { token: T })).status, 204);
    assert.strictEqual((await call('PUT', `/dr/v1/appointment/${a2}/follow-up/confirm`, { token: T, body: { start_time: st() + 86400 * 7, end_time: st() + 86400 * 7 + 900 } })).status, 204);
    assert.strictEqual((await call('GET', `/dr/v1/appointment/${a2}`, { token: T })).body.status, 'BK');
  });
  await test('list by patient', async () => {
    const r = await call('GET', `/dr/v1/appointment?patient_id=${patientId}`, { token: T });
    assert.ok(r.body.appointments.length >= 4);
  });

  await test('reschedule in place (PUT v1)', async () => {
    const b = await call('POST', '/dr/v1/appointment', { token: T, body: { partner_appointment_id: 'PA-PUT-1', clinic_id: CLINIC, doctor_id: DOC, patient_id: patientId, appointment_details: { start_time: st() + 13500 } } });
    const id = b.body.appointment_id;
    const r = await call('PUT', '/dr/v1/appointment/PA-PUT-1/reschedule?partner_id=1', { token: T, body: { start_time: st() + 14400, end_time: st() + 15300, partner_clinic_id: 'CL01', partner_doctor_id: 'test-doc-456' } });
    assert.strictEqual(r.status, 204);
    const g = (await call('GET', `/dr/v1/appointment/${id}`, { token: T })).body;
    assert.strictEqual(g.start_time, st() + 14400); assert.strictEqual(g.status, 'BK');
    await call('PUT', `/dr/v1/appointment/${id}/cancel?partner_id=0`, { token: T });
    assert.strictEqual((await call('PUT', `/dr/v1/appointment/${id}/reschedule?partner_id=0`, { token: T, body: { start_time: st(), end_time: st() + 900 } })).status, 403);
  });
  await test('custom attributes merge', async () => {
    const r = await call('PATCH', `/dr/v1/appointment/${newApptId}/custom_attribute?partner_id=0`, { token: T, body: { payment_status: ['paid'] } });
    assert.strictEqual(r.status, 204);
    const ca = (await call('GET', `/dr/v1/appointment/${newApptId}`, { token: T })).body.custom_attributes;
    assert.deepStrictEqual(ca.payment_status, ['paid']); assert.deepStrictEqual(ca.label, ['vitals_submitted']);
    assert.strictEqual((await call('PATCH', `/dr/v1/appointment/${newApptId}/custom_attribute?partner_id=0`, { token: T, body: {} })).status, 400);
  });
  await test('all appointments for a patient', async () => {
    const r = await call('GET', `/dr/v1/appointment/patient/${patientId}`, { token: T });
    assert.strictEqual(r.body.success, true); assert.ok(r.body.data.length >= 4);
    assert.match(r.body.data[0].start_time, /^\d{4}-\d{2}-\d{2}T/);
    const byPartner = (await call('GET', '/dr/v1/appointment/patient/EXT-NEW-9', { token: T })).body.data;
    assert.ok(byPartner.some((a) => a.appointment_id === apptId && a.stage === 'RESCHEDULED'));
  });

  console.log('\nDoctor clinics, schedules & service-conf');
  await test('clinics for doctor', async () => {
    const r = await call('GET', `/v1/doctor/clinics/${DOC}`, { token: T });
    assert.ok(r.body.data.clinics.some((c) => c.clinic_id === CLINIC));
    assert.strictEqual((await call('GET', '/v1/doctor/clinics/000', { token: T })).status, 403);
  });
  let confId;
  await test('service-conf list and details', async () => {
    const r = await call('GET', `/schedule/service-conf/${DOC}`, { token: T });
    assert.strictEqual(r.body.success, true); assert.ok(r.body.data.length >= 2);
    assert.ok(r.body.data.every((c) => c.mode.every((m) => ['in-clinic', 'tele'].includes(m))));
    confId = r.body.data.find((c) => c.mode.includes('in-clinic')).conf_id;
    assert.strictEqual((await call('GET', `/schedule/service-conf/${DOC}/${confId}`, { token: T })).body.data.conf_id, confId);
    assert.strictEqual((await call('GET', `/schedule/service-conf/${DOC}/nope`, { token: T })).status, 404);
    assert.ok((await call('GET', `/schedule/service-conf/${CLINIC}`, { token: T })).body.data.length >= 2);
  });
  const range = `startTime=${day}T00:00:00%2B05:30&endTime=${addDays(day, 1)}T00:00:00%2B05:30`;
  let seededSchedule;
  await test('resolved schedule shows the seeded widget schedule', async () => {
    const r = await call('GET', `/schedule/resolved?entity_id=${DOC}&location_id=${CLINIC}&product_id=product-widget&include_rules=true&${range}`, { token: T });
    assert.strictEqual(r.status, 200);
    const sch = r.body.data[DOC][0]; seededSchedule = sch.schedule_id;
    const b = sch.schedule[day].bounds;
    assert.strictEqual(b[0].s, `${day}T09:00:00.000+05:30`); assert.strictEqual(b[0].source, 'weekly');
    assert.strictEqual(b[0].services[0].conf_id, confId);
    assert.ok(sch.rules.weekly['1']);
    assert.strictEqual((await call('GET', `/schedule/resolved?entity_id=${DOC}&${range}`, { token: T })).status, 400);
    assert.strictEqual((await call('GET', `/schedule/resolved?entity_id=${DOC}&location_id=${CLINIC}&product_id=x&${range}`, { token: T })).status, 400);
  });
  await test('blocking the widget schedule removes slots', async () => {
    const p = await call('PATCH', `/schedule/${seededSchedule}`, { token: T, body: { timebounds: { block: [{ start_date: day, end_date: day, start_time: '09:00', end_time: '10:00' }] } } });
    assert.strictEqual(p.status, 200); const blockId = p.body.data.timebounds.block[0];
    const slots = (await call('GET', `/dr/v1/doctor/${DOC}/clinic/${CLINIC}/appointment/slot?start_date=${day}&end_date=${day}`, { token: T })).body.data.schedule[CLINIC].slots;
    assert.ok(!slots.some((x) => x.s === `${day}T09:00:00+05:30`)); assert.ok(slots.some((x) => x.s === `${day}T10:00:00+05:30`));
    const d = await call('PATCH', `/schedule/${seededSchedule}`, { token: T, body: { deleteTimebounds: { block: [blockId] } } });
    assert.deepStrictEqual(d.body.data.deleted.block, [blockId]);
  });
  await test('overbooking_limit frees a booked slot', async () => {
    const slots = async () => (await call('GET', `/dr/v1/doctor/${DOC}/clinic/${CLINIC}/appointment/slot?start_date=${day}&end_date=${day}`, { token: T })).body.data.schedule[CLINIC].slots;
    const free = [...(await slots())].reverse().find((x) => x.available);
    const start = Math.floor(new Date(free.s).getTime() / 1000);
    const id = (await call('POST', '/dr/v1/appointment', { token: T, body: { clinic_id: CLINIC, doctor_id: DOC, patient_id: patientId, appointment_details: { start_time: start, end_time: start + 900 } } })).body.appointment_id;
    assert.strictEqual((await slots()).find((x) => x.s === free.s).available, false);
    await call('PATCH', `/schedule/${seededSchedule}`, { token: T, body: { config: { overbooking_limit: 2 } } });
    assert.strictEqual((await slots()).find((x) => x.s === free.s).available, true);
    await call('PATCH', `/schedule/${seededSchedule}`, { token: T, body: { config: { overbooking_limit: 1 } } });
    await call('PUT', `/dr/v1/appointment/${id}/cancel?partner_id=0`, { token: T });
  });
  let schedId;
  await test('create schedule: validation and product-widget conflict', async () => {
    const base = { name: 'Evening OPD', entity_id: DOC, location_id: CLINIC };
    assert.strictEqual((await call('POST', '/schedule', { token: T, body: {} })).status, 400);
    assert.strictEqual((await call('POST', '/schedule', { token: T, body: { ...base, timebounds: { weekly: { 1: { is_enabled: true, bounds: [{ s: 900, e: 1300, conf_ids: ['nope'] }] } } } } })).status, 400);
    assert.strictEqual((await call('POST', '/schedule', { token: T, body: { ...base, config: { schedule_slot_config_enabled: true, slot_durations: [15] }, timebounds: { weekly: { 1: { bounds: [{ s: 900, e: 1300, conf_ids: [confId] }] } } } } })).status, 400);
    assert.strictEqual((await call('POST', '/schedule', { token: T, body: { ...base, config: { schedule_slot_config_enabled: true } } })).status, 400);
    assert.strictEqual((await call('POST', '/schedule', { token: T, body: { ...base, productMap: { 'product-widget': true } } })).status, 409);
    const r = await call('POST', '/schedule', { token: T, body: { ...base, config: { slot_durations: [30, 15, 15] }, productMap: { 'product-emr': true },
      timebounds: { daily: { [day]: { is_enabled: true, bounds: [{ s: 1800, e: 2100, conf_ids: [confId] }] } }, 'repeat-daily': [{ phase_index: 0, repeat_every: 2, anchor_date: day, bounds: [{ s: 700, e: 800, conf_ids: [confId] }] }] } } });
    assert.strictEqual(r.status, 201); schedId = r.body.data.schedule_id;
    assert.deepStrictEqual(r.body.data.config.slot_durations, [15, 30]);
    assert.deepStrictEqual(r.body.data.assignment.products, ['product-emr']);
    const res = await call('GET', `/schedule/resolved?entity_id=${DOC}&location_id=${CLINIC}&${range}`, { token: T });
    const mine = res.body.data[DOC].find((x) => x.schedule_id === schedId);
    assert.strictEqual(mine.schedule[day].bounds[0].source, 'daily');
  });
  await test('update and delete schedule', async () => {
    assert.strictEqual((await call('PATCH', `/schedule/${schedId}`, { token: T, body: {} })).status, 400);
    assert.strictEqual((await call('PATCH', '/schedule/nope', { token: T, body: { name: 'x' } })).status, 404);
    assert.strictEqual((await call('PATCH', `/schedule/${schedId}`, { token: T, body: { archive: true, timebounds: { weekly: {} } } })).status, 409);
    const r = await call('PATCH', `/schedule/${schedId}`, { token: T, body: { deleteTimebounds: { daily: ['bk_missing'] } } });
    assert.strictEqual(r.status, 200); assert.ok(r.body.data.failed_tasks.length);
    assert.strictEqual((await call('PATCH', `/schedule/${schedId}`, { token: T, body: { archive: true } })).body.data.archive, true);
    assert.strictEqual((await call('PATCH', `/schedule/${schedId}`, { token: T, body: { name: 'y' } })).status, 409);
    assert.strictEqual((await call('DELETE', `/schedule/${schedId}`, { token: T })).body.success, true);
    assert.strictEqual((await call('DELETE', `/schedule/${schedId}`, { token: T })).status, 404);
  });

  console.log('\nEMR user');
  const EMR = info.seeded_ids.ekauser;
  await test('get and update EMR user profile', async () => {
    const h = { 'client-id': client_id };
    assert.strictEqual((await call('GET', `/profiles/v1/emr-user/${EMR}`, { token: T })).status, 400);
    const g = await call('GET', `/profiles/v1/emr-user/${EMR}`, { token: T, headers: h });
    assert.strictEqual(g.body.ps, 'S'); assert.strictEqual(g.body.oid, EMR);
    assert.strictEqual((await call('PATCH', `/profiles/v1/emr-user/${EMR}`, { token: T, headers: h, body: { bg: 'Z+' } })).status, 400);
    const u = await call('PATCH', `/profiles/v1/emr-user/${EMR}`, { token: T, headers: h, body: { fln: 'Front Desk Admin', bg: 'B+', mobile: '+919876543210' } });
    assert.strictEqual(u.body.message, 'Profile updated successfully');
    const g2 = (await call('GET', `/profiles/v1/emr-user/${EMR}`, { token: T, headers: h })).body;
    assert.strictEqual(g2.fln, 'Front Desk Admin'); assert.strictEqual(g2.bg, 'B+'); assert.strictEqual(g2.mobile, '+919876543210');
    assert.strictEqual((await call('GET', '/profiles/v1/emr-user/nope', { token: T, headers: h })).status, 404);
  });

  console.log('\nWebhook delivery & signature');
  await test('events received and signatures verify', async () => {
    await sleep(500);
    const rec = (await call('GET', '/_sandbox/webhook-receiver')).body.received;
    const events = rec.map((x) => x.body.event);
    for (const e of ['appointment.created', 'appointment.updated', 'appointment.statuschange', 'prescription.created']) assert.ok(events.includes(e), `missing ${e}`);
    // verify signature exactly as the Eka docs describe (payload must be the raw body string)
    const deliveries = (await call('GET', '/_sandbox/webhooks/deliveries')).body.deliveries;
    const d0 = deliveries[0];
    const { t, v1 } = Object.fromEntries(d0.request.headers['Eka-Webhook-Signature'].split(',').map((kv) => kv.split('=')));
    const expected = crypto.createHmac('sha256', SIGNING).update(`${t}.${JSON.stringify(d0.request.body)}`).digest('hex');
    assert.strictEqual(v1, expected);
    assert.ok(deliveries.every((x) => x.response_status === 200));
  });
  await test('delete webhook', async () => {
    assert.strictEqual((await call('DELETE', `/notification/v1/connect/webhook/subscriptions/${whId}`, { token: T })).body.msg, 'success');
  });

  console.log('\nPayments, IPD, notify');
  await test('transaction status', async () => {
    assert.strictEqual((await call('GET', '/dr/v1/payment/transaction_status/txn-sandbox-0001', { token: T })).body.payment_status, 'PAYMENT_SUCCESS');
    assert.strictEqual((await call('GET', '/dr/v1/payment/transaction_status/nope', { token: T })).status, 404);
    const p = (await call('POST', `/_sandbox/appointments/${newApptId}/payment`, { body: { payment_status: 'PAYMENT_SUCCESS' } })).body;
    assert.strictEqual((await call('GET', `/dr/v1/payment/transaction_status/${p.transaction_id}`, { token: T })).body.payment_status, 'PAYMENT_SUCCESS');
    assert.strictEqual((await call('GET', `/dr/v1/appointment/${newApptId}`, { token: T })).body.payment.payment_id, p.transaction_id);
  });
  await test('IPD create + get', async () => {
    const c = await call('POST', '/appointments/v1/ipd/admission', { token: T, body: { ipid: 'IPD-1', patient: { id: patientId, profile: { personal: { gender: 'M', name: 'Test Patient' } } }, doc: { id: DOC, name: 'Dr. Priya Sharma' }, bed: 'W-1' } });
    assert.strictEqual(c.status, 201); assert.strictEqual(c.body.status, 'BED_ASSIGNED');
    assert.strictEqual((await call('GET', `/appointments/v1/ipd/admission/${c.body.id}`, { token: T })).body.bed, 'W-1');
  });
  await test('notify', async () => {
    const ok = await call('POST', '/notification/v1/notify', { token: T, body: { partner_payload: { partner_doctor_id: 'test-doc-456', message: { title: 't', body: 'b' }, landing_page: 'q', params: { aid: apptId } } } });
    assert.strictEqual(ok.body.status, 'success');
    const bad = await call('POST', '/notification/v1/notify', { token: T, body: { partner_payload: { partner_doctor_id: 'test-doc-456', message: { title: 't', body: 'b' }, landing_page: 'w' } } });
    assert.strictEqual(bad.status, 400);
  });

  console.log('\nMisc');
  await test('unknown route -> 404, wrong method -> 405, bad JSON -> 400', async () => {
    assert.strictEqual((await call('GET', '/nope', { token: T })).status, 404);
    assert.strictEqual((await call('DELETE', '/dr/v1/business/entities', { token: T })).status, 405);
    const r = await fetch(BASE + '/dr/v1/patient', { method: 'POST', headers: { auth: T, 'Content-Type': 'application/json' }, body: '{bad' });
    assert.strictEqual(r.status, 400);
  });
  await test('dashboard renders', async () => {
    const r = await fetch(BASE + '/');
    assert.ok((await r.text()).includes('Eka Doc Tool Sandbox'));
  });
  await test('reset', async () => {
    await call('POST', '/_sandbox/reset');
    assert.strictEqual((await call('GET', `/dr/v1/appointment/${newApptId}`, { token: long_lived_api_key })).status, 404);
  });

  srv.kill();
  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
