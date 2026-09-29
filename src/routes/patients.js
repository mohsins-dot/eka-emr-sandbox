'use strict';
const store = require('../store');
const { E, HttpError } = require('../router');
const M = require('../models');
const { randDigits, now, splitMobile, dobFromAge, isValidDate, clean } = require('../util');

const GENDERS = ['M', 'F', 'O'];

function newOid() {
  const d = store.db();
  let id;
  do { id = randDigits(15); } while (d.patients[id]);
  return id;
}

function fullName(fn, mn, ln) {
  return [fn, mn, ln].filter(Boolean).join(' ');
}

/** Create a patient from Doc Tool style fields (first_name, gender, dob|age, mobile, ...). Used by /dr/v1/patient and booking. */
function createFromDr(b) {
  const errors = [];
  if (!b.first_name) errors.push('first_name is required');
  if (!GENDERS.includes(b.gender)) errors.push('gender is required and must be one of M, F, O');
  if (!b.dob && (b.age === undefined || b.age === null)) errors.push('either dob or age is required');
  if (b.dob && !isValidDate(b.dob)) errors.push('dob must be YYYY-MM-DD');
  if (errors.length) throw E.err(400, 'INVALID_REQUEST_PARAMETERS', errors.join('; '));
  const d = store.db();
  if (b.partner_patient_id && Object.values(d.patients).some((p) => p.partner_patient_id === String(b.partner_patient_id) && !p.arc)) {
    throw E.err(409, 'PATIENT_ALREADY_EXISTS', `A patient with partner_patient_id ${b.partner_patient_id} already exists`);
  }
  const { ccd, mobile } = splitMobile(b.mobile);
  const t = now();
  const p = clean({
    oid: newOid(), wid: d.business.business_id, s: b.designation, fn: b.first_name, mn: b.middle_name || '', ln: b.last_name || '',
    fln: fullName(b.first_name, b.middle_name, b.last_name), gen: b.gender, dob: b.dob || dobFromAge(b.age), is_age: !b.dob,
    ccd, mobile, email: b.email, partner_patient_id: b.partner_patient_id ? String(b.partner_patient_id) : undefined,
    address: b.address, partner_meta: b.partner_meta || {}, extras: {}, arc: false, c_ate: t, u_ate: t,
  });
  d.patients[p.oid] = p;
  store.save();
  return p;
}

function profileValidate(b, { partial }) {
  if (!partial) {
    if (!b.dob) throw new HttpError(400, { error: { message: 'dob is required', code: 'invalid_request' } });
    if (!b.gen) throw new HttpError(400, { error: { message: 'gen is required', code: 'invalid_request' } });
    if (!b.fn && !b.fln) throw new HttpError(400, { error: { message: 'either fn or fln is required', code: 'invalid_request' } });
  }
  if (b.gen !== undefined && !GENDERS.includes(b.gen)) throw new HttpError(400, { error: { message: 'Invalid Gender Enum', code: 'invalid_request' } });
  if (b.dob !== undefined && !isValidDate(b.dob)) throw new HttpError(400, { error: { message: 'Invalid dob, expected YYYY-MM-DD', code: 'invalid_request' } });
}

function applyProfile(p, b) {
  for (const k of ['s', 'dob', 'gen', 'email', 'username', 'abha']) if (b[k] !== undefined) p[k] = b[k];
  if (b.bloodgroup !== undefined) p.bg = b.bloodgroup;
  if (b.mobile !== undefined) Object.assign(p, splitMobile(b.mobile));
  if (b.extras !== undefined) p.extras = { ...(p.extras || {}), ...b.extras };
  if (b.fln !== undefined && b.fn === undefined) {
    const parts = String(b.fln).trim().split(/\s+/);
    p.fn = parts[0]; p.ln = parts.length > 1 ? parts[parts.length - 1] : ''; p.mn = parts.slice(1, -1).join(' ');
    p.fln = b.fln;
  } else if (b.fn !== undefined || b.mn !== undefined || b.ln !== undefined) {
    if (b.fn !== undefined) p.fn = b.fn;
    if (b.mn !== undefined) p.mn = b.mn;
    if (b.ln !== undefined) p.ln = b.ln;
    p.fln = fullName(p.fn, p.mn, p.ln);
  }
  p.u_ate = now();
}

function notFoundProfile() {
  return new HttpError(404, { message: 'Not found', code: 'profile_not_found' });
}

function register(r) {
  // ================= Patient Registration (Doc Tool /dr/v1) =================

  r.add('POST', '/dr/v1/patient', ({ body }) => {
    const p = createFromDr(body || {});
    return { status: 201, body: { patient_id: p.oid } };
  });

  r.add('GET', '/dr/v1/business/patients/search', ({ query }) => {
    const mob = String(query.mobile || '').replace(/\D/g, '').slice(-10);
    if (mob.length !== 10) throw E.err(400, 'INVALID_REQUEST_PARAMETERS', 'mobile must be a 10 digit number');
    const list = Object.values(store.db().patients).filter((p) => !p.arc && p.mobile === mob);
    if (!list.length) throw new HttpError(404, { success: false, status_code: 404, error: { code: 'PATIENTS_NOT_FOUND', message: 'No patients found for this mobile number' } });
    return {
      data: {
        profiles: list.map((p) => ({
          name: p.fln, patient_id: p.oid,
          patient_profile: clean({ patient_id: p.oid, first_name: p.fn, middle_name: p.mn, last_name: p.ln, dob: p.dob, gender: p.gen, mobile: `${p.ccd}${p.mobile}`, created_at: p.c_ate, partner_patient_id: p.partner_patient_id }),
        })),
      },
      status_code: 200,
      success: true,
    };
  });

  r.add('GET', '/dr/v1/patient/:patient_id', ({ params }) => {
    const p = store.findPatient(params.patient_id);
    if (!p) throw E.err(404, 'PATIENT_NOT_FOUND', `Patient ${params.patient_id} not found in this business directory`);
    return M.drPatient(p);
  });

  r.add('PATCH', '/dr/v1/patient/:patient_id', ({ params, body }) => {
    const p = store.findPatient(params.patient_id);
    if (!p) throw E.err(404, 'PATIENT_NOT_FOUND', `Patient ${params.patient_id} not found in this business directory`);
    const b = body || {};
    if (b.gender !== undefined && !GENDERS.includes(b.gender)) throw E.err(400, 'INVALID_REQUEST_PARAMETERS', 'gender must be one of M, F, O');
    if (b.dob !== undefined && !isValidDate(b.dob)) throw E.err(400, 'INVALID_REQUEST_PARAMETERS', 'dob must be YYYY-MM-DD');
    const map = { designation: 's', first_name: 'fn', middle_name: 'mn', last_name: 'ln', gender: 'gen', dob: 'dob', email: 'email' };
    for (const [k, v] of Object.entries(map)) if (b[k] !== undefined) p[v] = b[k];
    if (b.age !== undefined && b.dob === undefined) { p.dob = dobFromAge(b.age); p.is_age = true; }
    if (b.dob !== undefined) p.is_age = false;
    if (b.mobile !== undefined) Object.assign(p, splitMobile(b.mobile));
    if (b.address !== undefined) p.address = { ...(p.address || {}), ...b.address };
    if (b.partner_meta !== undefined) p.partner_meta = b.partner_meta;
    p.fln = fullName(p.fn, p.mn, p.ln);
    p.u_ate = now();
    store.save();
    return { status: 201, body: { patient_id: p.oid } };
  });

  // ================= Patient Directory (/profiles/v1) =================
  const pd = { clientIdHeader: true };

  r.add('POST', '/profiles/v1/patient', ({ body }) => {
    const b = body || {};
    profileValidate(b, { partial: false });
    const d = store.db();
    const t = now();
    const p = { oid: newOid(), wid: d.business.business_id, fn: '', mn: '', ln: '', fln: '', is_age: false, extras: {}, partner_meta: {}, arc: false, c_ate: t, u_ate: t };
    applyProfile(p, b);
    p.c_ate = t;
    d.patients[p.oid] = clean(p);
    store.save();
    return { status: 201, body: { oid: p.oid } };
  }, pd);

  r.add('GET', '/profiles/v1/patient/minified', ({ query }) => {
    if (query.pageNo === undefined) throw new HttpError(400, { error: { message: 'pageNo is required', code: 'invalid_request' } });
    const pageNo = Math.max(1, Number(query.pageNo) || 1);
    const pageSize = Math.min(2000, Math.max(1, Number(query.pageSize) || 500));
    const includeArc = String(query.arc) === 'true';
    const from = query.from ? Number(query.from) : 0;
    const extra = String(query.select || '').split(',').map((s) => s.trim()).filter(Boolean);
    const all = Object.values(store.db().patients)
      .filter((p) => (includeArc || !p.arc) && p.c_ate >= from)
      .sort((a, b) => a.c_ate - b.c_ate || a.oid.localeCompare(b.oid));
    const slice = all.slice((pageNo - 1) * pageSize, pageNo * pageSize);
    return {
      profiles: slice.map((p) => {
        const o = { mobile: p.mobile, fln: p.fln, oid: p.oid, username: p.username, wid: p.wid };
        for (const k of extra) if (p[k] !== undefined) o[k] = p[k];
        if (includeArc) o.arc = !!p.arc;
        return clean(o);
      }),
      currPageMeta: { currPageNo: pageNo, pageSize, nextPage: pageNo * pageSize < all.length ? pageNo + 1 : -1 },
    };
  }, pd);

  r.add('GET', '/profiles/v1/patient/search', ({ query }) => {
    const prefix = String(query.prefix || '').trim().toLowerCase();
    if (!prefix) throw new HttpError(400, { error: { message: 'prefix is required', code: 'invalid_request' } });
    const limit = Math.min(50, Math.max(1, Number(query.limit) || 50));
    const extra = String(query.select || '').split(',').map((s) => s.trim()).filter(Boolean);
    return Object.values(store.db().patients)
      .filter((p) => !p.arc && [p.username, p.mobile, p.fln, p.fn, p.ln].some((v) => v && String(v).toLowerCase().startsWith(prefix)))
      .slice(0, limit)
      .map((p) => {
        const o = { username: p.username, mobile: p.mobile, oid: p.oid, fln: p.fln };
        for (const k of extra) if (p[k] !== undefined) o[k] = p[k];
        return clean(o);
      });
  }, pd);

  r.add('GET', '/profiles/v1/patient/by-mobile', ({ query }) => {
    const mob = String(query.mob || '');
    if (!/^\+\d{11,15}$/.test(mob)) throw new HttpError(400, { error: { message: 'mob must be in the format +<country_code><number>, e.g. +911234567890', code: 'invalid_request' } });
    const { ccd, mobile } = splitMobile(mob);
    const p = Object.values(store.db().patients).find((x) => !x.arc && x.mobile === mobile && (x.ccd || '+91') === ccd);
    if (!p) throw notFoundProfile();
    if (String(query.full_profile) === 'true') return M.profile(p);
    return clean({ mobile: p.mobile, fln: p.fln, dob: p.dob, gen: p.gen, oid: p.oid, username: p.username, abha: p.abha, ccd: p.ccd, ps: 'P' });
  }, pd);

  r.add('GET', '/profiles/v1/patient/:username/username', ({ params }) => {
    const list = Object.values(store.db().patients).filter((p) => !p.arc && p.username === params.username);
    if (!list.length) throw notFoundProfile();
    return list.map(M.profile);
  }, pd);

  r.add('GET', '/profiles/v1/patient/:oid', ({ params, query }) => {
    const p = store.db().patients[params.oid];
    if (!p || (p.arc && String(query.arc) !== 'true')) throw notFoundProfile();
    return M.profile(p);
  }, pd);

  r.add('PATCH', '/profiles/v1/patient/:oid', ({ params, body }) => {
    const p = store.db().patients[params.oid];
    if (!p || p.arc) throw notFoundProfile();
    const b = body || {};
    profileValidate(b, { partial: true });
    applyProfile(p, b);
    store.save();
    return { message: 'Profile updated successfully' };
  }, pd);

  r.add('DELETE', '/profiles/v1/patient/:oid', ({ params, query }) => {
    const d = store.db();
    const p = d.patients[params.oid];
    if (!p) throw notFoundProfile();
    if (String(query.perm) === 'true') {
      if (!p.arc) throw new HttpError(400, { message: 'Profile must be archived before it can be permanently deleted', code: 'invalid_request' });
      delete d.patients[params.oid];
      store.save();
      return { message: 'Profile deleted permanently' };
    }
    if (p.arc) throw notFoundProfile();
    p.arc = true;
    p.u_ate = now();
    store.save();
    return { message: 'Profile archived successfully' };
  }, pd);
}

module.exports = register;
module.exports.createFromDr = createFromDr;
