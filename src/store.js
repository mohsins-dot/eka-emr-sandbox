'use strict';
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { seed } = require('./seed');

let data = null;
let saveTimer = null;

function load() {
  if (config.persist && fs.existsSync(config.dataFile)) {
    try {
      data = JSON.parse(fs.readFileSync(config.dataFile, 'utf8'));
      return data;
    } catch (e) {
      console.warn(`[sandbox] Could not read ${config.dataFile} (${e.message}); reseeding.`);
    }
  }
  return reset();
}

function reset() {
  data = seed();
  saveNow();
  return data;
}

function saveNow() {
  if (!config.persist) return;
  fs.mkdirSync(path.dirname(config.dataFile), { recursive: true });
  fs.writeFileSync(config.dataFile, JSON.stringify(data, null, 2));
}

function save() {
  if (!config.persist) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 50);
}

function db() {
  if (!data) load();
  return data;
}

// ---------- lookups (accept Eka ID or partner ID) ----------

function findDoctor(id) {
  if (!id) return null;
  const d = db();
  const hit = d.doctors[id] || Object.values(d.doctors).find((x) => x.partner_id && String(x.partner_id) === String(id));
  return hit && !hit.deleted ? hit : null;
}

function findClinic(id) {
  if (!id) return null;
  const d = db();
  const hit = d.clinics[id] || Object.values(d.clinics).find((x) => x.partner_id && String(x.partner_id) === String(id));
  return hit && !hit.deleted ? hit : null;
}

function findEkaUser(id) {
  if (!id) return null;
  const d = db();
  const hit = d.ekausers[id] || Object.values(d.ekausers).find((x) => x.partner_id && String(x.partner_id) === String(id));
  return hit && !hit.deleted ? hit : null;
}

function findPatient(id, { includeArchived = false } = {}) {
  if (!id) return null;
  const d = db();
  const hit = d.patients[id] || Object.values(d.patients).find((x) => x.partner_patient_id && String(x.partner_patient_id) === String(id));
  if (!hit) return null;
  if (hit.arc && !includeArchived) return null;
  return hit;
}

function findAppointment(id, partnerFlag) {
  if (!id) return null;
  const d = db();
  const byPartner = () => Object.values(d.appointments).find((a) => a.partner_appointment_id && String(a.partner_appointment_id) === String(id));
  if (String(partnerFlag) === '1') return byPartner() || null;
  return d.appointments[id] || byPartner() || null;
}

function doctorsOfClinic(clinicId) {
  return Object.values(db().doctors).filter((doc) => !doc.deleted && doc.clinic_ids.includes(clinicId));
}

function flush() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (data) saveNow();
}

module.exports = { load, reset, save, flush, db, findDoctor, findClinic, findEkaUser, findPatient, findAppointment, doctorsOfClinic };
