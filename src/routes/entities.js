'use strict';
const store = require('../store');
const { E, HttpError } = require('../router');
const M = require('../models');
const { services } = require('../seed');
const { randDigits, hex, now, isValidDate } = require('../util');

const GENDERS = ['M', 'F', 'O'];

function newId(coll, gen) {
  let id;
  do { id = gen(); } while (coll[id]);
  return id;
}

/** Resolve either `<x>_ids` (Eka IDs) or `partner_<x>_ids`. Throws on "both" or unknown IDs. */
function resolveIds(b, kind, finder) {
  const ekaKey = `${kind}_ids`;
  const partnerKey = `partner_${kind}_ids`;
  if (b[ekaKey] !== undefined && b[partnerKey] !== undefined) throw E.cdr(400, `Provide either ${ekaKey} or ${partnerKey}, not both`);
  const list = b[ekaKey] !== undefined ? b[ekaKey] : b[partnerKey];
  if (list === undefined) return undefined;
  if (!Array.isArray(list)) throw E.cdr(400, `${b[ekaKey] !== undefined ? ekaKey : partnerKey} must be an array`);
  return list.map((id) => {
    const hit = finder(id);
    if (!hit) throw E.cdr(400, `Unknown ${kind} id: ${id}`);
    return hit.id;
  });
}

function checkPartnerUnique(coll, partnerId, selfId, label) {
  if (partnerId === undefined || partnerId === null || partnerId === '') return;
  const dup = Object.values(coll).find((x) => !x.deleted && x.id !== selfId && String(x.partner_id) === String(partnerId));
  if (dup) throw E.cdr(400, `A ${label} with partner_id ${partnerId} already exists`);
}

function validatePerson(b, partial) {
  const errors = {};
  if (!partial) {
    if (!b.firstname) errors.firstname = ['This field is required.'];
    if (!b.lastname) errors.lastname = ['This field is required.'];
    if (!b.gender) errors.gender = ['This field is required.'];
  }
  if (b.gender !== undefined && !GENDERS.includes(b.gender)) errors.gender = ['"' + b.gender + '" is not a valid choice. Use M, F or O.'];
  if (b.mobile !== undefined && b.mobile !== null && b.mobile !== '' && !/^\d{10}$/.test(String(b.mobile))) errors.mobile = ['Mobile must be exactly 10 digits.'];
  if (b.dob !== undefined && b.dob !== null && !isValidDate(b.dob)) errors.dob = ['Date has wrong format. Use YYYY-MM-DD.'];
  if (b.email !== undefined && b.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email)) errors.email = ['Enter a valid email address.'];
  if (Object.keys(errors).length) throw E.cdr(400, 'Validation failed', errors);
}

function setClinicDoctors(clinicId, doctorIds) {
  for (const doc of Object.values(store.db().doctors)) {
    const has = doc.clinic_ids.includes(clinicId);
    const want = doctorIds.includes(doc.id);
    if (want && !has) doc.clinic_ids.push(clinicId);
    if (!want && has) doc.clinic_ids = doc.clinic_ids.filter((c) => c !== clinicId);
  }
}

function register(r) {
  // ================= Doctor & Clinic (read) =================

  r.add('GET', '/dr/v1/business/entities', () => {
    const d = store.db();
    const clinics = Object.values(d.clinics).filter((c) => !c.deleted);
    const doctors = Object.values(d.doctors).filter((x) => !x.deleted);
    return {
      status_code: 200,
      success: true,
      data: {
        clinics: clinics.map((c) => ({ clinic_id: c.id, name: c.name, partner_clinic_id: c.partner_id || null, doctors: store.doctorsOfClinic(c.id).map((x) => x.id) })),
        doctors: doctors.map((x) => ({ doctor_id: x.id, name: `Dr. ${M.docName(x)}`, partner_doctor_id: x.partner_id || null, pic: x.profile_image_url || '' })),
        business: { business_id: d.business.business_id, name: d.business.name },
      },
    };
  });

  r.add('GET', '/dr/v1/doctor/service/:doctor_id', ({ params }) => {
    const doc = store.findDoctor(params.doctor_id);
    if (!doc) throw E.err(404, 'DOCTOR_NOT_FOUND', `Doctor ${params.doctor_id} not found`);
    const list = (store.db().services[doc.id] || []).filter((s) => !s.archive);
    return {
      data: {
        services: list.map((s) => ({
          appointment_type: s.appointment_type, archive: s.archive, book_ahead_days: s.book_ahead_days, created_at: s.created_at,
          currency: s.currency, duration: s.duration, mode: s.mode, pre_pay: s.pre_pay, post_pay: s.post_pay, price: s.price,
          service_name: s.service_name, conf_id: s.conf_id,
        })),
      },
    };
  });

  r.add('GET', '/dr/v1/doctor/:doctor_id', ({ params }) => {
    const doc = store.findDoctor(params.doctor_id);
    if (!doc) throw new HttpError(500, { error: { code: 'SERVER_ERROR', message: 'Doctor id entered is incorrect' } });
    return M.drDoctorProfile(doc);
  });

  r.add('GET', '/dr/v1/business/clinic/:clinic_id', ({ params }) => {
    const c = store.findClinic(params.clinic_id);
    if (!c) throw new HttpError(404, { success: false, code: 'CLINIC_NOT_FOUND', message: 'The specified clinic_id does not exist' });
    return { success: true, data: { clinic: M.drClinic(c) } };
  });

  r.add('GET', '/cdr/v1/get_business_info', () => {
    const b = store.db().business;
    return { status: 'success', bid: b.business_id, business_name: b.name };
  });

  // ================= Onboarding: Doctors =================

  r.add('POST', '/cdr/v1/doctor', ({ body }) => {
    const b = body || {};
    validatePerson(b, false);
    const d = store.db();
    const clinicIds = resolveIds(b, 'clinic', store.findClinic) || [];
    checkPartnerUnique(d.doctors, b.partner_id, null, 'doctor');
    const id = newId(d.doctors, () => randDigits(15));
    d.doctors[id] = {
      id, partner_id: b.partner_id ?? null, salutation: 'Dr.', firstname: b.firstname, middlename: '', lastname: b.lastname,
      gender: b.gender, dob: b.dob || '1990-01-01', mobile: b.mobile || null, email: b.email || null,
      specialisations: b.specialisations || [], qualifications: b.qualifications || [], about: b.about || '',
      profile_image_url: b.profile_image_url || null, clinic_ids: clinicIds, deleted: false, created_at: now(),
    };
    d.services[id] = services(id, 500);
    store.save();
    return { status: 201, body: { status: 'success', ekaid: id } };
  });

  r.add('GET', '/cdr/v1/doctor', () => ({
    status: 'success',
    doctors: Object.values(store.db().doctors).filter((x) => !x.deleted).map((x) => M.cdrDoctor(x, false)),
  }));

  r.add('GET', '/cdr/v1/doctor/:doc_id', ({ params }) => {
    const doc = store.findDoctor(params.doc_id);
    if (!doc) throw E.cdr(404, 'Doctor not found');
    return { status: 'success', doctor: M.cdrDoctor(doc, true) };
  });

  r.add('PATCH', '/cdr/v1/doctor/:doc_id', ({ params, body }) => {
    const doc = store.findDoctor(params.doc_id);
    if (!doc) throw E.cdr(404, 'Doctor not found');
    const b = body || {};
    validatePerson(b, true);
    const clinicIds = resolveIds(b, 'clinic', store.findClinic);
    checkPartnerUnique(store.db().doctors, b.partner_id, doc.id, 'doctor');
    for (const k of ['firstname', 'lastname', 'mobile', 'email', 'gender', 'dob', 'specialisations', 'qualifications', 'about', 'profile_image_url', 'partner_id']) {
      if (b[k] !== undefined) doc[k] = b[k];
    }
    if (clinicIds !== undefined) doc.clinic_ids = clinicIds;
    store.save();
    return { status: 'success', ekaid: doc.id };
  });

  r.add('DELETE', '/cdr/v1/doctor/:doc_id', ({ params }) => {
    const doc = store.findDoctor(params.doc_id);
    if (!doc) throw E.cdr(404, 'Doctor not found');
    doc.deleted = true;
    store.save();
    return { status: 'success', message: 'Doctor Deleted Successfully' };
  });

  // ================= Onboarding: Clinics =================

  r.add('POST', '/cdr/v1/clinic', ({ body }) => {
    const b = body || {};
    const errors = {};
    if (!b.name) errors.name = ['This field is required.'];
    if (!b.address) errors.address = ['This field is required.'];
    if (b.contact && !/^\d{10,11}$/.test(String(b.contact))) errors.contact = ['Contact must be 10-11 digits.'];
    if (Object.keys(errors).length) throw E.cdr(400, 'Validation failed', errors);
    const d = store.db();
    const doctorIds = resolveIds(b, 'doctor', store.findDoctor) || [];
    checkPartnerUnique(d.clinics, b.partner_id, null, 'clinic');
    const id = newId(d.clinics, () => hex(24));
    d.clinics[id] = {
      id, partner_id: b.partner_id ?? null, name: b.name, address: b.address, line2: '', city: b.city || '', state: b.state || '',
      country: 'India', pincode: b.pincode ? String(b.pincode) : '', contact: b.contact ? String(b.contact) : '', email: '',
      lat: '', lon: '', deleted: false, created_at: now(),
    };
    setClinicDoctors(id, doctorIds);
    store.save();
    return { status: 201, body: { status: 'success', ekaid: id } };
  });

  r.add('GET', '/cdr/v1/clinic', () => ({
    status: 'success',
    clinics: Object.values(store.db().clinics).filter((c) => !c.deleted).map((c) => M.cdrClinic(c, false)),
  }));

  r.add('GET', '/cdr/v1/clinic/:clinic_id', ({ params }) => {
    const c = store.findClinic(params.clinic_id);
    if (!c) throw E.cdr(404, 'Clinic not found');
    return { status: 'success', clinic: M.cdrClinic(c, true) };
  });

  r.add('PATCH', '/cdr/v1/clinic/:clinic_id', ({ params, body }) => {
    const c = store.findClinic(params.clinic_id);
    if (!c) throw E.cdr(404, 'Clinic not found');
    const b = body || {};
    if (b.contact && !/^\d{10,11}$/.test(String(b.contact))) throw E.cdr(400, 'Validation failed', { contact: ['Contact must be 10-11 digits.'] });
    const doctorIds = resolveIds(b, 'doctor', store.findDoctor);
    checkPartnerUnique(store.db().clinics, b.partner_id, c.id, 'clinic');
    for (const k of ['name', 'address', 'partner_id', 'pincode', 'contact', 'city', 'state']) if (b[k] !== undefined) c[k] = b[k];
    if (doctorIds !== undefined) setClinicDoctors(c.id, doctorIds);
    store.save();
    return { status: 'success', ekaid: c.id };
  });

  r.add('DELETE', '/cdr/v1/clinic/:clinic_id', ({ params }) => {
    const c = store.findClinic(params.clinic_id);
    if (!c) throw E.cdr(404, 'Clinic not found');
    c.deleted = true;
    store.save();
    return { status: 'success', message: 'Clinic Deleted Successfully' };
  });

  // ================= Onboarding: Eka Users (HIP users) =================

  function validateUser(b, partial) {
    validatePerson(b, partial);
    const errors = {};
    if (!partial) {
      if (!b.dob) errors.dob = ['This field is required.'];
      if (!b.mobile && !b.email && !b.auth_userid) errors.non_field_errors = ['At least one of mobile, email or auth_userid is required.'];
    }
    if (b.seat_type !== undefined && !['b', 'p'].includes(b.seat_type)) errors.seat_type = ['Must be "b" (basic) or "p" (premium).'];
    if (b.persona !== undefined && !['S', 'D'].includes(b.persona)) errors.persona = ['Must be "S" (staff) or "D" (doctor).'];
    if (Object.keys(errors).length) throw E.cdr(400, 'Validation failed', errors);
  }

  r.add('POST', '/cdr/v1/ekauser', ({ body }) => {
    const b = body || {};
    validateUser(b, false);
    const d = store.db();
    const doctorIds = resolveIds(b, 'doctor', store.findDoctor) || [];
    const clinicIds = resolveIds(b, 'clinic', store.findClinic) || [];
    checkPartnerUnique(d.ekausers, b.partner_id, null, 'user');
    const id = newId(d.ekausers, () => randDigits(15));
    d.ekausers[id] = {
      id, partner_id: b.partner_id ?? null, firstname: b.firstname, lastname: b.lastname, gender: b.gender, dob: b.dob,
      mobile: b.mobile || null, email: b.email || null, auth_userid: b.auth_userid || null, is_admin: !!b.is_admin,
      seat_type: b.seat_type || 'b', persona: b.persona || 'D', doctor_ids: doctorIds, clinic_ids: clinicIds, deleted: false, created_at: now(),
    };
    store.save();
    return { status: 201, body: { status: 'success', ekaid: id } };
  });

  const listUsers = () => ({ status: 'success', users: Object.values(store.db().ekausers).filter((u) => !u.deleted).map(M.cdrEkaUser) });
  r.add('GET', '/cdr/v1/ekauser', listUsers);
  r.add('GET', '/cdr/v1/hipusers', listUsers);

  const getUser = ({ params }) => {
    const u = store.findEkaUser(params.user_id);
    if (!u) throw E.cdr(404, 'User not found');
    return { status: 'success', user: M.cdrEkaUser(u) };
  };
  r.add('GET', '/cdr/v1/ekauser/:user_id', getUser);
  r.add('GET', '/cdr/v1/hipusers/:user_id', getUser);

  r.add('PATCH', '/cdr/v1/ekauser/:user_id', ({ params, body }) => {
    const u = store.findEkaUser(params.user_id);
    if (!u) throw E.cdr(404, 'User not found');
    const b = body || {};
    validateUser(b, true);
    const doctorIds = resolveIds(b, 'doctor', store.findDoctor);
    const clinicIds = resolveIds(b, 'clinic', store.findClinic);
    checkPartnerUnique(store.db().ekausers, b.partner_id, u.id, 'user');
    for (const k of ['firstname', 'lastname', 'mobile', 'email', 'gender', 'dob', 'is_admin', 'seat_type', 'persona', 'partner_id']) if (b[k] !== undefined) u[k] = b[k];
    if (doctorIds !== undefined) u.doctor_ids = doctorIds;
    if (clinicIds !== undefined) u.clinic_ids = clinicIds;
    store.save();
    return { status: 'success', ekaid: u.id };
  });

  r.add('DELETE', '/cdr/v1/ekauser/:user_id', ({ params }) => {
    const u = store.findEkaUser(params.user_id);
    if (!u) throw E.cdr(404, 'User not found');
    u.deleted = true;
    store.save();
    return { status: 'success', message: 'User Deleted Successfully' };
  });
}

module.exports = register;
