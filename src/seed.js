'use strict';
/**
 * Seed data. IDs are fixed so docs, the Postman collection and client test suites can rely on them.
 * All people, phone numbers and emails below are fictional.
 */
const crypto = require('crypto');
const config = require('./config');
const { now, istDate, istEpoch, addDays } = require('./util');

const BUSINESS_ID = '77088166996724';

const IDS = {
  business: BUSINESS_ID,
  doctors: {
    rahul: '174159057723920',
    priya: '174159057723921',
    arjun: '174159057723922',
  },
  clinics: {
    bangalore: '67978400352a61001d64e9fb',
    mumbai: '67978400352a61001d64e9fc',
  },
  patients: ['174678912588401', '174678912588402', '174678912588403', '174678912588404', '174678912588405'],
  ekauser: '176338032692057',
};

function confId(doctorId, name) {
  return crypto.createHash('sha256').update(`${doctorId}:${name}`).digest('hex');
}

function services(doctorId, basePrice) {
  const ts = 1752230657;
  return [
    {
      conf_id: confId(doctorId, 'consultation'),
      service_id: 1,
      service_name: 'consultation',
      appointment_type: 'REGULAR',
      archive: false,
      book_ahead_days: 30,
      created_at: ts,
      currency: 'INR',
      duration: 15,
      mode: ['in-clinic'],
      pre_pay: false,
      post_pay: true,
      price: basePrice,
      conv_fee: 0,
      discount: 0,
      allow_patient_booking: true,
    },
    {
      conf_id: confId(doctorId, 'tele-consultation'),
      service_id: 2,
      service_name: 'Tele Consultation',
      appointment_type: 'REGULAR',
      archive: false,
      book_ahead_days: 30,
      created_at: ts,
      currency: 'INR',
      duration: 15,
      mode: ['tele'],
      pre_pay: true,
      post_pay: false,
      price: basePrice - 100,
      conv_fee: 0,
      discount: 0,
      allow_patient_booking: true,
    },
  ];
}

/** One schedule per doctor per clinic, built from CLINIC_SESSIONS / CLOSED_WEEKDAYS and assigned to both products. */
function schedules(doctors, svc) {
  const toMil = (min) => Math.floor(min / 60) * 100 + (min % 60);
  const ts = new Date().toISOString();
  const out = {};
  for (const doc of Object.values(doctors)) {
    const conf = (svc[doc.id] || []).find((s) => s.mode.includes('in-clinic'));
    if (!conf) continue;
    for (const clinicId of doc.clinic_ids) {
      const id = crypto.createHash('sha256').update(`schedule:${doc.id}:${clinicId}`).digest('hex').slice(0, 24);
      const weekly = {};
      for (let day = 0; day < 7; day++) {
        const open = !config.closedWeekdays.includes(day);
        weekly[day] = { is_enabled: open, bounds: open ? config.sessions.map((x) => ({ s: toMil(x.start), e: toMil(x.end), conf_ids: [conf.conf_id] })) : [] };
      }
      out[id] = {
        schedule_id: id, business_id: BUSINESS_ID, name: `Dr. ${doc.firstname} ${doc.lastname} - OPD`, entity_id: doc.id, location_id: clinicId,
        archive: false, default: true, userCreatedDefault: false,
        config: { overbooking_limit: 1, block_over_existing_bookings: false, schedule_slot_config_enabled: false, slot_durations: [] },
        rules: { weekly, daily: {}, 'repeat-weekly': [], 'repeat-daily': [], block: [] },
        products: ['product-emr', 'product-widget'], createdAt: ts, updatedAt: ts,
      };
    }
  }
  return out;
}

function seed() {
  const t = now();
  const today = istDate(t);
  const tomorrow = addDays(today, 1);
  const yesterday = addDays(today, -1);

  const doctors = {
    [IDS.doctors.rahul]: {
      id: IDS.doctors.rahul, partner_id: 'test-doc-123', salutation: 'Dr.', firstname: 'Rahul', middlename: '', lastname: 'Kumar',
      gender: 'M', dob: '1978-04-12', mobile: '9000000001', email: 'rahul.kumar@sandbox.example',
      specialisations: ['Cardiologist', 'General Physician'], qualifications: ['MBBS', 'MD', 'DM (Cardiology)'],
      about: 'Sandbox cardiologist with 20 years of experience.', profile_image_url: 'https://example.com/sandbox/dr-rahul.png',
      clinic_ids: [IDS.clinics.bangalore, IDS.clinics.mumbai], deleted: false, created_at: t,
    },
    [IDS.doctors.priya]: {
      id: IDS.doctors.priya, partner_id: 'test-doc-456', salutation: 'Dr.', firstname: 'Priya', middlename: '', lastname: 'Sharma',
      gender: 'F', dob: '1985-09-02', mobile: '9000000002', email: 'priya.sharma@sandbox.example',
      specialisations: ['General Physician', 'Diabetologist'], qualifications: ['MBBS', 'MD (Medicine)'],
      about: 'Sandbox general physician.', profile_image_url: 'https://example.com/sandbox/dr-priya.png',
      clinic_ids: [IDS.clinics.bangalore], deleted: false, created_at: t,
    },
    [IDS.doctors.arjun]: {
      id: IDS.doctors.arjun, partner_id: 'test-doc-789', salutation: 'Dr.', firstname: 'Arjun', middlename: '', lastname: 'Mehta',
      gender: 'M', dob: '1982-01-20', mobile: '9000000003', email: 'arjun.mehta@sandbox.example',
      specialisations: ['Pediatrician'], qualifications: ['MBBS', 'DCH'],
      about: 'Sandbox pediatrician.', profile_image_url: 'https://example.com/sandbox/dr-arjun.png',
      clinic_ids: [IDS.clinics.mumbai], deleted: false, created_at: t,
    },
  };

  const clinics = {
    [IDS.clinics.bangalore]: {
      id: IDS.clinics.bangalore, partner_id: 'CL01', name: 'Sandbox Heart & Wellness Clinic',
      address: '302, 3rd Floor, Sandbox Towers, 80 Feet Road', line2: 'Koramangala', city: 'Bangalore', state: 'Karnataka',
      country: 'India', pincode: '560034', contact: '08000000001', email: 'blr@sandbox.example', lat: '12.9352', lon: '77.6245',
      deleted: false, created_at: t,
    },
    [IDS.clinics.mumbai]: {
      id: IDS.clinics.mumbai, partner_id: 'CL02', name: 'Sandbox Family Care Clinic',
      address: '12, Sandbox Arcade, Linking Road', line2: 'Bandra West', city: 'Mumbai', state: 'Maharashtra',
      country: 'India', pincode: '400050', contact: '02200000002', email: 'bom@sandbox.example', lat: '19.0596', lon: '72.8295',
      deleted: false, created_at: t,
    },
  };

  const people = [
    ['Mr.', 'Aarav', '', 'Patel', 'M', '1990-05-14', '9999900001', 'B+'],
    ['Ms.', 'Diya', '', 'Iyer', 'F', '1995-11-03', '9999900002', 'O+'],
    ['Mrs.', 'Kavya', 'R', 'Nair', 'F', '1968-02-27', '9999900003', 'A+'],
    ['Mr.', 'Rohan', '', 'Gupta', 'M', '2012-07-19', '9999900001', 'AB+'], // shares mobile with Aarav (family)
    ['Mr.', 'Vikram', '', 'Singh', 'M', '1955-12-01', '9999900005', 'O-'],
  ];
  const patients = {};
  people.forEach((p, i) => {
    const oid = IDS.patients[i];
    patients[oid] = {
      oid, wid: BUSINESS_ID, s: p[0], fn: p[1], mn: p[2], ln: p[3], fln: [p[1], p[2], p[3]].filter(Boolean).join(' '),
      gen: p[4], dob: p[5], is_age: false, ccd: '+91', mobile: p[6], bg: p[7],
      email: `${p[1].toLowerCase()}@patient.sandbox.example`, username: `UH000${i + 1}`,
      partner_patient_id: `PT-000${i + 1}`, address: { city: i < 3 ? 'Bangalore' : 'Mumbai', pincode: i < 3 ? '560034' : '400050' },
      partner_meta: {}, extras: {}, arc: false, c_ate: t, u_ate: t,
    };
  });

  const svc = {
    [IDS.doctors.rahul]: services(IDS.doctors.rahul, 800),
    [IDS.doctors.priya]: services(IDS.doctors.priya, 500),
    [IDS.doctors.arjun]: services(IDS.doctors.arjun, 600),
  };

  const ekausers = {
    [IDS.ekauser]: {
      id: IDS.ekauser, partner_id: 'USR-01', firstname: 'Front', lastname: 'Desk', gender: 'F', dob: '1992-03-03',
      mobile: '9000000010', email: 'frontdesk@sandbox.example', is_admin: true, seat_type: 'p', persona: 'S',
      doctor_ids: [IDS.doctors.rahul, IDS.doctors.priya], clinic_ids: [IDS.clinics.bangalore], deleted: false, created_at: t,
    },
  };

  const rxId = 'P-DW-SANDBOX-0001';
  const apptDone = 'api-sandbox-0000-0000-0000-000000000001';
  const apptBooked = 'api-sandbox-0000-0000-0000-000000000002';

  const appointments = {
    [apptDone]: {
      appointment_id: apptDone, partner_appointment_id: 'PA-0001', doctor_id: IDS.doctors.rahul, clinic_id: IDS.clinics.bangalore,
      patient_id: IDS.patients[0], status: 'CM', mode: 'INCLINIC', channel: 'Walkin', token: 1,
      start_time: istEpoch(yesterday, 10, 0), end_time: istEpoch(yesterday, 10, 15), created_at: t - 86400, modified_at: t - 80000,
      conf_id: svc[IDS.doctors.rahul][0].conf_id, prescription_id: rxId, custom_attributes: { label: ['vitals_submitted'] },
      partner_meta: { encounter_id: 'ENC-0001' }, display_meta: {}, notes: '<p>Follow-up for chest pain.</p>',
      payment: { payment_id: 'txn-sandbox-0001', payment_status: 'PAYMENT_SUCCESS', amount: 800 }, prev_aids: [],
    },
    [apptBooked]: {
      appointment_id: apptBooked, partner_appointment_id: 'PA-0002', doctor_id: IDS.doctors.priya, clinic_id: IDS.clinics.bangalore,
      patient_id: IDS.patients[1], status: 'BK', mode: 'INCLINIC', channel: 'API', token: 1,
      start_time: istEpoch(tomorrow, 9, 30), end_time: istEpoch(tomorrow, 9, 45), created_at: t, modified_at: t,
      conf_id: svc[IDS.doctors.priya][0].conf_id, prescription_id: null, custom_attributes: {}, partner_meta: {}, display_meta: {},
      notes: '', payment: { payment_id: null, payment_status: null, amount: null }, prev_aids: [],
    },
  };

  const prescriptions = {
    [rxId]: samplePrescription({
      prescription_id: rxId, appointment: appointments[apptDone], doctor: doctors[IDS.doctors.rahul],
      patient: patients[IDS.patients[0]], clinic: clinics[IDS.clinics.bangalore], created_at: t - 80000,
    }),
  };

  const transactions = {
    'txn-sandbox-0001': { transaction_id: 'txn-sandbox-0001', amount: 800, created_at: new Date((t - 86400) * 1000).toISOString().replace('Z', '+0000'), payment_gateway: 'Ezetap', payment_mode: 'UPI', payment_status: 'PAYMENT_SUCCESS', rrn: '4275481' },
    'txn-sandbox-0002': { transaction_id: 'txn-sandbox-0002', amount: 500, created_at: new Date(t * 1000).toISOString().replace('Z', '+0000'), payment_gateway: 'Ezetap', payment_mode: 'CARD', payment_status: 'PAYMENT_FAILED', rrn: '4275482' },
    'txn-sandbox-0003': { transaction_id: 'txn-sandbox-0003', amount: 600, created_at: new Date(t * 1000).toISOString().replace('Z', '+0000'), payment_gateway: 'Ezetap', payment_mode: 'UPI', payment_status: 'PAYMENT_PENDING', rrn: null },
  };

  return {
    meta: { seeded_at: t, version: 2 },
    business: { business_id: BUSINESS_ID, name: 'Eka Sandbox Hospitals Pvt Ltd' },
    doctors, clinics, patients, services: svc, schedules: schedules(doctors, svc), ekausers, appointments, prescriptions, transactions,
    admissions: {}, webhooks: {}, webhookSeq: 0, deliveries: [], received: [], notifications: [], refreshTokens: {},
  };
}

function samplePrescription({ prescription_id, appointment, doctor, patient, clinic, created_at }) {
  const followUp = new Date((appointment.start_time + 7 * 86400) * 1000).toISOString().replace('.000Z', '+00:00');
  return {
    prescription_id,
    doctor_id: doctor.id, partner_doctor_id: doctor.partner_id,
    doctor_name: `${doctor.firstname} ${doctor.lastname}`.trim(),
    patient_name: patient.fln, patient_id: patient.oid, partner_patient_id: patient.partner_patient_id,
    appointment_id: appointment.appointment_id, partner_appointment_id: appointment.partner_appointment_id,
    clinic_id: clinic.id, partner_clinic_id: clinic.partner_id,
    current_version: '1', previous_version: null,
    prescription_url: `https://sandbox.eka.invalid/prescriptions/${prescription_id}.pdf`,
    prescription_url_print: `https://sandbox.eka.invalid/prescriptions/${prescription_id}-print.pdf`,
    created_at, modified_at: created_at,
    prescription_details: [
      { resource_type: 'appointment', follow_up: followUp, note: [] },
      { resource_type: 'condition_history', condition: { code: '38341003', display: 'High blood pressure' }, severity: 'active', onset: null, clinical_status: { code: 'active', display: 'active' }, verification_status: { code: 'confirmed', display: 'confirmed' } },
      { resource_type: 'condition', condition: { code: '194828000', display: 'Angina' }, severity: null, onset: null, clinical_status: { code: 'active', display: 'active' }, verification_status: { code: 'confirmed', display: 'confirmed' } },
      { resource_type: 'advices', advices: 'Low-salt diet. Walk 30 minutes daily. Return immediately if chest pain worsens.', status: 'active', intent: 'plan' },
      { resource_type: 'observation', status: 'final', observation: { code: '29857009', display: 'chest pain' }, severity: { code: '', display: '' }, category: { code: 'symptom', display: 'symptom' }, note: [] },
      { resource_type: 'vitals', status: 'final', observation: { code: 'lb-1201285132', display: 'Pulse rate' }, since: { type: 'datetime', start: new Date(appointment.start_time * 1000).toISOString().replace('Z', '+00:00') }, category: { code: 'vital-signs', display: 'Vital Signs' }, valueQuantity: { system: 'http://eka.care/mdb/technical', unit: '/min', value: 72 } },
      { resource_type: 'medicationrequest', drug_id: 'sandbox-drug-0001', drug_status: 'active', med_name: 'Olmesartan 40 Tablet', dose: { id: 'du-5550260779', value: 1, unit: 'tablet', custom: '1.0 tablet' }, dosage_instruction: { custom: '1-0-1', when: ['MORN', 'NIGHT'], period: '1', period_unit: 'd', frequency: 2 }, duration: { unit: 'wk', value: 2, custom: '2 wk' }, note: 'Take with water' },
      { resource_type: 'servicerequest', lab_id: 'sandbox-lab-0001', status: 'active', lab_name: 'ECG', note: [] },
    ],
  };
}

module.exports = { seed, samplePrescription, services, schedules, confId, IDS, BUSINESS_ID };
