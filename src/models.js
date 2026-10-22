'use strict';
/** Presenters: convert internal records into the response shapes each Eka API family uses. */
const store = require('./store');
const { clean, istIso } = require('./util');

// ---------- Patients ----------

function drPatient(p) {
  return clean({
    patient_id: p.oid,
    partner_patient_id: p.partner_patient_id,
    designation: p.s,
    first_name: p.fn,
    middle_name: p.mn,
    last_name: p.ln,
    gender: p.gen,
    dob: p.dob,
    is_age: p.is_age,
    mobile: p.mobile ? `${p.ccd || '+91'}${p.mobile}` : undefined,
    email: p.email,
    address: p.address,
    relations: [],
    created_at: p.c_ate,
    partner_meta: p.partner_meta || {},
  });
}

function profile(p) {
  return clean({
    oid: p.oid, wid: p.wid, ps: 'P', c_ate: p.c_ate, u_ate: p.u_ate, gen: p.gen, dob: p.dob, is_age: p.is_age,
    fn: p.fn, mn: p.mn || undefined, ln: p.ln || undefined, fln: p.fln, bg: p.bg, mobile: p.mobile, ccd: p.ccd,
    email: p.email, username: p.username, s: p.s, abha: p.abha, extras: p.extras && Object.keys(p.extras).length ? p.extras : undefined,
    arc: p.arc || undefined,
  });
}

// ---------- Doctors / clinics ----------

function docName(d) {
  return [d.firstname, d.lastname].filter(Boolean).join(' ');
}

function clinicRef(c) {
  return { id: c.id, name: c.name };
}

function doctorRef(d) {
  return { id: d.id, firstname: d.firstname, lastname: d.lastname };
}

function doctorClinics(d) {
  return d.clinic_ids.map((id) => store.db().clinics[id]).filter((c) => c && !c.deleted);
}

function cdrDoctor(d, full) {
  const base = {
    id: d.id, firstname: d.firstname, lastname: d.lastname, mobile: d.mobile, email: d.email,
    specialisation: d.specialisations[0] || null, clinics: doctorClinics(d).map(clinicRef), partner_id: d.partner_id || null,
  };
  if (full) Object.assign(base, { gender: d.gender, dob: d.dob, profile_image_url: d.profile_image_url, about: d.about, specialisations: d.specialisations, qualifications: d.qualifications });
  return base;
}

function cdrClinic(c, full) {
  const base = {
    id: c.id, name: c.name, pincode: c.pincode, address: c.address,
    doctors: store.doctorsOfClinic(c.id).map(doctorRef), partner_id: c.partner_id || null,
  };
  if (full) Object.assign(base, { contact: c.contact, mobile: c.contact, city: c.city, state: c.state });
  return base;
}

function drDoctorProfile(d) {
  return {
    id: d.id,
    profile: {
      personal: { salutation: d.salutation || 'Dr.', first_name: d.firstname, middle_name: d.middlename || '', last_name: d.lastname, email: d.email, gender: d.gender, dob: d.dob },
      professional: {
        username: `dr-${d.firstname}-${d.lastname}`.toLowerCase().replace(/[^a-z0-9-]/g, ''),
        active: true,
        about: d.about || '',
        language: [{ code: 'en', language: 'English' }, { code: 'hi', language: 'Hindi' }],
        degree: [{ id: 1, name: d.qualifications.join(','), branch_name: '', college_name: '', display_status: 'active', start_year: '', end_year: '' }],
        major_speciality: { name: d.specialisations[0] || 'General Physician', code: (d.specialisations[0] || 'GP').slice(0, 2).toUpperCase() },
        speciality: d.specialisations.slice(1).map((name) => ({ name })),
        clinics: doctorClinics(d).map((c) => ({
          id: c.id, city_name: c.city, name: c.name, email: c.email, about: '', speciality: [],
          number: [{ name: 'Phone', n: c.contact }],
          address: { line1: c.address, line2: c.line2 || '', city: c.city, state: c.state, country: c.country || 'India', pincode: c.pincode },
          location: [Number(c.lat) || 0, Number(c.lon) || 0],
        })),
        default_clinic: d.clinic_ids[0] || null,
        all_registrations: [{ id: 1, council: 'Sandbox Medical Council', medical_id: `SBX${d.id.slice(-5)}`, year: '2005', default: true }],
      },
    },
  };
}

function drClinic(c) {
  return {
    clinic_id: c.id, name: c.name,
    address: { city: c.city, country: c.country || 'India', lat: c.lat || '', line1: c.address, lon: c.lon || '', pincode: c.pincode, state: c.state },
  };
}

function cdrEkaUser(u) {
  const d = store.db();
  return {
    id: u.id, firstname: u.firstname, lastname: u.lastname, mobile: u.mobile || null, email: u.email || null,
    is_admin: !!u.is_admin, seat_type: u.seat_type, persona: u.persona,
    doctors: (u.doctor_ids || []).map((id) => d.doctors[id]).filter((x) => x && !x.deleted).map(doctorRef),
    clinics: (u.clinic_ids || []).map((id) => d.clinics[id]).filter((x) => x && !x.deleted).map(clinicRef),
    partner_id: u.partner_id || null,
  };
}

// ---------- Appointments ----------

const MODE_OUT = { INCLINIC: 'in_clinic', PHONE: 'phone', VIDEO: 'video' };

function apptIds(a) {
  const d = store.db();
  const doc = d.doctors[a.doctor_id] || {};
  const cl = d.clinics[a.clinic_id] || {};
  const pt = d.patients[a.patient_id] || {};
  return { partner_doctor_id: doc.partner_id || null, partner_clinic_id: cl.partner_id || null, partner_patient_id: pt.partner_patient_id || null };
}

function rxUrl(a) {
  const rx = a.prescription_id && store.db().prescriptions[a.prescription_id];
  return rx ? rx.prescription_url : null;
}

function appointmentSummary(a) {
  return {
    appointment_id: a.appointment_id, partner_appointment_id: a.partner_appointment_id || null, created_at: a.created_at,
    doctor_id: a.doctor_id, clinic_id: a.clinic_id, patient_id: a.patient_id, channel: a.channel, status: a.status,
    mode: MODE_OUT[a.mode] || a.mode, start_time: a.start_time, end_time: a.end_time, prescription_id: a.prescription_id || null,
    prescription_url: rxUrl(a), ...apptIds(a),
  };
}

function appointmentDetail(a) {
  const d = store.db();
  const svc = (d.services[a.doctor_id] || []).find((s) => s.conf_id === a.conf_id) || (d.services[a.doctor_id] || [])[0];
  return {
    appointment_id: a.appointment_id, partner_appointment_id: a.partner_appointment_id || null, created_at: a.created_at,
    doctor_id: a.doctor_id, clinic_id: a.clinic_id, patient_id: a.patient_id, ...apptIds(a),
    channel: a.channel, status: a.status, mode: MODE_OUT[a.mode] || a.mode, start_time: a.start_time, end_time: a.end_time,
    token: a.token ?? null,
    payment: a.payment || { payment_id: null, payment_status: null, amount: null },
    prescription_id: a.prescription_id || null,
    service: svc ? {
      created_at: svc.created_at, mode: svc.mode.map((m) => (m === 'in-clinic' ? 'INCLINIC' : m.toUpperCase())), price: svc.price,
      post_pay: svc.post_pay, service_name: svc.service_name, book_ahead_days: svc.book_ahead_days,
      appointment_type: svc.appointment_type, allow_patient_booking: svc.allow_patient_booking,
    } : null,
    prescription_url: rxUrl(a),
    custom_attributes: a.custom_attributes || {},
    partner_meta: a.partner_meta || {},
    display_meta: a.display_meta || {},
    video_connect: a.video_connect,
    notes: a.notes || '',
    prev_aids: a.prev_aids && a.prev_aids.length ? a.prev_aids : undefined,
    next_aid: a.next_aid,
  };
}

/** Item of GET /dr/v1/appointment/patient/{patient_id} */
function patientAppointment(a) {
  const d = store.db();
  const svc = (d.services[a.doctor_id] || []).find((s) => s.conf_id === a.conf_id);
  const iso = (t) => (t ? new Date(t * 1000).toISOString() : null);
  const stage = { BK: 'BOOKED', PA: 'PARKED', OG: 'ONGOING', CM: 'COMPLETED', CMNP: 'COMPLETED', NS: 'NO_SHOW', CN: 'CANCELLED', RES: 'RESCHEDULED' }[a.status] || a.status;
  return {
    appointment_id: a.appointment_id, created_at: iso(a.created_at), doctor_id: a.doctor_id, patient_id: a.patient_id, clinic_id: a.clinic_id,
    channel: a.channel, status: a.status, start_time: iso(a.start_time), end_time: iso(a.end_time),
    visit_checkin: iso(a.created_at), visit_start: iso(a.visit_start), visit_end: iso(a.visit_end), stage,
    'visit-type': a.channel === 'Walkin' ? 'WALKIN' : 'APPOINTMENT',
    payment: a.payment || { payment_id: null, payment_status: null, amount: null },
    prescription_id: a.prescription_id || null,
    service: svc ? [{
      created_at: iso(svc.created_at), mode: svc.mode, price: svc.price, post_pay: svc.post_pay, service_name: svc.service_name,
      book_ahead_days: svc.book_ahead_days, appointment_type: svc.appointment_type, allow_patient_booking: svc.allow_patient_booking,
    }] : [],
  };
}

/** Payload for appointment.* webhooks */
function appointmentEvent(a, action) {
  return {
    appointment_id: a.appointment_id, partner_appointment_id: a.partner_appointment_id || null,
    doctor_id: a.doctor_id, patient_id: a.patient_id, clinic_id: a.clinic_id, ...apptIds(a),
    status: a.status, action, created_at: a.created_at, modified_at: a.modified_at,
    custom_attributes: a.custom_attributes || {}, partner_meta: a.partner_meta || {},
  };
}

function prescriptionEvent(rx, action) {
  return {
    prescription_id: rx.prescription_id, doctor_id: rx.doctor_id, partner_doctor_id: rx.partner_doctor_id, patient_id: rx.patient_id,
    current_version: rx.current_version, previous_version: rx.previous_version, prescription_url: rx.prescription_url,
    prescription_url_print: rx.prescription_url_print, partner_patient_id: rx.partner_patient_id, clinic_id: rx.clinic_id,
    partner_clinic_id: rx.partner_clinic_id, appointment_id: rx.appointment_id, partner_appointment_id: rx.partner_appointment_id,
    action, created_at: rx.created_at, modified_at: rx.modified_at, partner_meta: {},
  };
}

function prescriptionDetail(rx) {
  const { current_version, previous_version, created_at, modified_at, prescription_url, prescription_url_print, ...rest } = rx;
  return rest;
}

module.exports = {
  drPatient, profile, cdrDoctor, cdrClinic, drDoctorProfile, drClinic, cdrEkaUser, doctorRef, clinicRef, docName,
  appointmentSummary, appointmentDetail, patientAppointment, appointmentEvent, prescriptionEvent, prescriptionDetail,
};
