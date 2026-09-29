'use strict';
const crypto = require('crypto');

const IST_OFFSET_SEC = 19800; // +05:30

function randDigits(n) {
  let s = String(1 + Math.floor(Math.random() * 9));
  while (s.length < n) s += Math.floor(Math.random() * 10);
  return s;
}

function hex(n) {
  return crypto.randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n);
}

function uuid() {
  return crypto.randomUUID();
}

function now() {
  return Math.floor(Date.now() / 1000);
}

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

function signJwt(payload, secret) {
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64url(JSON.stringify(payload));
  const s = crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${s}`;
}

function verifyJwt(token, secret) {
  if (typeof token !== 'string') return { ok: false, reason: 'missing token' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed token' };
  const expected = crypto.createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest('base64url');
  const a = Buffer.from(expected);
  const b = Buffer.from(parts[2]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'invalid signature' };
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch (e) {
    return { ok: false, reason: 'malformed token' };
  }
  if (payload.exp && payload.exp < now()) return { ok: false, reason: 'token expired', payload };
  return { ok: true, payload };
}

/** Epoch seconds for a YYYY-MM-DD date + HH:MM in IST */
function istEpoch(dateStr, hh, mm) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d, hh, mm) / 1000) - IST_OFFSET_SEC;
}

/** ISO string with +05:30 offset for an epoch */
function istIso(epoch) {
  const iso = new Date((epoch + IST_OFFSET_SEC) * 1000).toISOString();
  return iso.slice(0, 19) + '+05:30';
}

/** YYYY-MM-DD in IST for an epoch */
function istDate(epoch) {
  return new Date((epoch + IST_OFFSET_SEC) * 1000).toISOString().slice(0, 10);
}

function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
}

/** Split "+919999999999" / "9999999999" / "+91 99999 99999" into { ccd, mobile } */
function splitMobile(input) {
  if (input === undefined || input === null || input === '') return { ccd: undefined, mobile: undefined };
  const raw = String(input).replace(/[\s-]/g, '');
  const digits = raw.replace(/\D/g, '');
  if (digits.length <= 10) return { ccd: '+91', mobile: digits };
  const mobile = digits.slice(-10);
  const cc = digits.slice(0, digits.length - 10);
  return { ccd: '+' + cc, mobile };
}

function dobFromAge(age) {
  const y = new Date().getUTCFullYear() - Number(age);
  return `${y}-01-01`;
}

function ageFromDob(dob) {
  if (!dob) return undefined;
  const d = new Date(dob + 'T00:00:00Z');
  const n = new Date();
  let age = n.getUTCFullYear() - d.getUTCFullYear();
  const md = n.getUTCMonth() - d.getUTCMonth();
  if (md < 0 || (md === 0 && n.getUTCDate() < d.getUTCDate())) age--;
  return age;
}

function clean(obj) {
  if (Array.isArray(obj)) return obj.map(clean);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = clean(v);
    return out;
  }
  return obj;
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

function deepClone(o) {
  return o === undefined ? undefined : JSON.parse(JSON.stringify(o));
}

module.exports = {
  IST_OFFSET_SEC, randDigits, hex, uuid, now, signJwt, verifyJwt, istEpoch, istIso, istDate,
  isValidDate, addDays, daysBetween, splitMobile, dobFromAge, ageFromDob, clean, pick, deepClone,
};
