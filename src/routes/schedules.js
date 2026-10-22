'use strict';
const store = require('../store');
const { HttpError } = require('../router');
const { RULE_TYPES, PRODUCTS, resolveDay } = require('../schedule');
const { hex, now, isValidDate, addDays, daysBetween, istDate, deepClone } = require('../util');

// Schedule APIs answer errors as { success: false, error }
function fail(status, error) {
  return new HttpError(status, { success: false, error });
}

function newBookingId() {
  return `bk_${hex(12)}`;
}

function isoNow() {
  return new Date().toISOString();
}

/** ISO timestamp with the UTC offset of `tz`, e.g. 2026-09-22T09:00:00.000+05:30 */
function isoInZone(epoch, tz) {
  const date = new Date(epoch * 1000);
  const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(date).find((p) => p.type === 'timeZoneName').value;
  const m = /GMT([+-]\d{2}):?(\d{2})?/.exec(name);
  const offset = m ? `${m[1]}:${m[2] || '00'}` : '+00:00';
  const [sign, hh, mm] = [offset[0] === '-' ? -1 : 1, Number(offset.slice(1, 3)), Number(offset.slice(4, 6))];
  const local = new Date(date.getTime() + sign * (hh * 60 + mm) * 60000).toISOString().slice(0, 23);
  return local + offset;
}

function validTimeZone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (e) { return false; }
}

// ---------- validation ----------

function checkConfig(c, durationMode) {
  if (c === undefined) return;
  if (typeof c !== 'object' || c === null || Array.isArray(c)) throw fail(400, 'config must be an object');
  if (c.overbooking_limit !== undefined && !(Number.isInteger(c.overbooking_limit) && c.overbooking_limit >= 1)) throw fail(400, 'config.overbooking_limit must be an integer >= 1');
  if (c.block_over_existing_bookings !== undefined && typeof c.block_over_existing_bookings !== 'boolean') throw fail(400, 'config.block_over_existing_bookings must be a boolean');
  if (c.schedule_slot_config_enabled !== undefined && typeof c.schedule_slot_config_enabled !== 'boolean') throw fail(400, 'config.schedule_slot_config_enabled must be a boolean');
  if (c.slot_durations !== undefined) {
    if (!Array.isArray(c.slot_durations) || c.slot_durations.length > 10) throw fail(400, 'config.slot_durations must be an array of at most 10 integers');
    if (!c.slot_durations.every((v) => Number.isInteger(v) && v >= 1 && v <= 1440)) throw fail(400, 'config.slot_durations values must be integers between 1 and 1440');
  }
  if (durationMode && !(c.slot_durations || []).length) throw fail(400, 'config.slot_durations must be non-empty when schedule_slot_config_enabled is true');
}

function normConfig(c, prev) {
  const out = { overbooking_limit: 1, block_over_existing_bookings: false, schedule_slot_config_enabled: false, slot_durations: [], ...(prev || {}), ...(c || {}) };
  out.slot_durations = [...new Set(out.slot_durations)].sort((a, b) => a - b);
  return out;
}

function checkMilitary(v, name) {
  if (!Number.isInteger(v) || v < 0 || v > 2400 || v % 100 >= 60) throw fail(400, `${name} must be a time in military format, e.g. 900 for 09:00`);
}

/** Validate a { is_enabled, bounds } day spec. `ctx.durationMode` and `ctx.confIds` decide the conf_ids rule. */
function checkDay(day, where, ctx) {
  if (!day || typeof day !== 'object') throw fail(400, `${where} must be an object with is_enabled and bounds`);
  if (day.is_enabled !== undefined && typeof day.is_enabled !== 'boolean') throw fail(400, `${where}.is_enabled must be a boolean`);
  if (day.bounds === undefined) return;
  if (!Array.isArray(day.bounds)) throw fail(400, `${where}.bounds must be an array`);
  day.bounds.forEach((b, i) => {
    const at = `${where}.bounds[${i}]`;
    checkMilitary(b.s, `${at}.s`);
    checkMilitary(b.e, `${at}.e`);
    if (b.e <= b.s) throw fail(400, `${at}.e must be after s`);
    if (ctx.durationMode) {
      if (b.conf_ids !== undefined) throw fail(400, `${at}.conf_ids is not allowed on a duration-based schedule (schedule_slot_config_enabled: true)`);
    } else {
      if (!Array.isArray(b.conf_ids) || !b.conf_ids.length) throw fail(400, `${at}.conf_ids must list at least one service-conf id on a service-based schedule`);
      if (!ctx.entityId) throw fail(400, `${at}.conf_ids cannot be checked without the schedule's entity_id`);
      const bad = b.conf_ids.find((id) => !ctx.confIds.includes(id));
      if (bad) throw fail(400, `${at}.conf_ids: ${bad} is not a service-conf of entity ${ctx.entityId}`);
    }
  });
}

function checkDate(v, name, required) {
  if (v === undefined && !required) return;
  if (!isValidDate(v)) throw fail(400, `${name} must be a YYYY-MM-DD date`);
}

function checkTimebounds(tb, ctx) {
  if (tb === undefined) return;
  if (typeof tb !== 'object' || tb === null || Array.isArray(tb)) throw fail(400, 'timebounds must be an object');
  for (const k of Object.keys(tb)) if (!RULE_TYPES.includes(k)) throw fail(400, `timebounds.${k} is not a rule type; use ${RULE_TYPES.join(', ')}`);
  for (const [day, spec] of Object.entries(tb.weekly || {})) {
    if (!/^[0-6]$/.test(day)) throw fail(400, `timebounds.weekly keys must be weekdays 0 (Sunday) to 6 (Saturday), got ${day}`);
    checkDay(spec, `timebounds.weekly.${day}`, ctx);
  }
  for (const [date, spec] of Object.entries(tb.daily || {})) {
    checkDate(date, `timebounds.daily key ${date}`, true);
    checkDay(spec, `timebounds.daily.${date}`, ctx);
  }
  for (const [k, list] of [['repeat-weekly', tb['repeat-weekly']], ['repeat-daily', tb['repeat-daily']], ['block', tb.block]]) {
    if (list !== undefined && !Array.isArray(list)) throw fail(400, `timebounds.${k} must be an array`);
  }
  (tb['repeat-weekly'] || []).forEach((r, i) => {
    const at = `timebounds.repeat-weekly[${i}]`;
    if (!Number.isInteger(r.repeat_every) || r.repeat_every < 1) throw fail(400, `${at}.repeat_every must be an integer >= 1`);
    checkDate(r.anchor_date, `${at}.anchor_date`, true);
    checkDate(r.start_date, `${at}.start_date`, false);
    checkDate(r.end_date, `${at}.end_date`, false);
    if (!Array.isArray(r.phases) || r.phases.length !== r.repeat_every) throw fail(400, `${at}.phases must have exactly repeat_every (${r.repeat_every}) entries`);
    r.phases.forEach((phase, p) => {
      for (const [day, spec] of Object.entries(phase || {})) {
        if (!/^[0-6]$/.test(day)) throw fail(400, `${at}.phases[${p}] keys must be weekdays 0 to 6`);
        checkDay(spec, `${at}.phases[${p}].${day}`, ctx);
      }
    });
  });
  (tb['repeat-daily'] || []).forEach((r, i) => {
    const at = `timebounds.repeat-daily[${i}]`;
    if (!Number.isInteger(r.repeat_every) || r.repeat_every < 1) throw fail(400, `${at}.repeat_every must be an integer >= 1`);
    if (!Number.isInteger(r.phase_index) || r.phase_index < 0 || r.phase_index >= r.repeat_every) throw fail(400, `${at}.phase_index must be between 0 and repeat_every - 1`);
    checkDate(r.anchor_date, `${at}.anchor_date`, true);
    checkDate(r.start_date, `${at}.start_date`, false);
    checkDate(r.end_date, `${at}.end_date`, false);
    checkDay(r, at, ctx);
  });
  (tb.block || []).forEach((b, i) => {
    const at = `timebounds.block[${i}]`;
    checkDate(b.start_date, `${at}.start_date`, true);
    checkDate(b.end_date, `${at}.end_date`, true);
    if (b.end_date < b.start_date) throw fail(400, `${at}.end_date cannot be before start_date`);
    for (const k of ['start_time', 'end_time']) {
      if (b[k] !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(b[k])) throw fail(400, `${at}.${k} must be HH:mm (24h)`);
    }
  });
}

function checkProductMap(pm) {
  if (pm === undefined) return;
  if (typeof pm !== 'object' || pm === null || Array.isArray(pm)) throw fail(400, 'productMap must be an object');
  for (const [k, v] of Object.entries(pm)) {
    if (!PRODUCTS.includes(k)) throw fail(400, `productMap key ${k} is not a product; use ${PRODUCTS.join(' or ')}`);
    if (typeof v !== 'boolean') throw fail(400, `productMap.${k} must be true or false`);
  }
}

/** Resolve entity_id / location_id (Eka or partner IDs) to Eka IDs. */
function resolveScope(b, prev = {}) {
  let entityId = prev.entity_id || null;
  let locationId = prev.location_id || null;
  if (b.entity_id !== undefined) {
    const doc = store.findDoctor(b.entity_id);
    if (!doc) throw fail(400, `entity_id ${b.entity_id} is not a doctor in this business`);
    entityId = doc.id;
  }
  if (b.location_id !== undefined) {
    const c = store.findClinic(b.location_id);
    if (!c) throw fail(400, `location_id ${b.location_id} is not a clinic in this business`);
    locationId = c.id;
  }
  return { entityId, locationId };
}

function confIdsOf(entityId) {
  return entityId ? (store.db().services[entityId] || []).map((s) => s.conf_id) : [];
}

/** Apply a productMap to a schedule; enforces the one-widget-schedule-per-scope rule. */
function applyProducts(s, pm) {
  if (!pm) return;
  for (const [product, on] of Object.entries(pm)) {
    if (!on) { s.products = s.products.filter((p) => p !== product); continue; }
    if (product === 'product-widget') {
      if (s.config.schedule_slot_config_enabled) throw fail(409, 'product-widget cannot be assigned to a duration-based schedule (schedule_slot_config_enabled: true)');
      const other = Object.values(store.db().schedules).find((x) => x.schedule_id !== s.schedule_id && !x.archive && x.entity_id === s.entity_id && x.location_id === s.location_id && x.products.includes('product-widget'));
      if (other) throw fail(409, `product-widget is already assigned to schedule ${other.schedule_id} for this entity_id and location_id`);
    }
    if (!s.products.includes(product)) s.products.push(product);
  }
}

/** Write timebounds into the schedule's rules; returns a report of affected rows keyed by rule type. */
function writeTimebounds(s, tb, { allowUpdate }) {
  const report = {};
  const note = (k, v) => { (report[k] = report[k] || []).push(v); };
  for (const [day, spec] of Object.entries(tb.weekly || {})) {
    s.rules.weekly[day] = { is_enabled: spec.is_enabled !== false, bounds: deepClone(spec.bounds || []) };
    note('weekly', day);
  }
  for (const [date, spec] of Object.entries(tb.daily || {})) {
    const existing = s.rules.daily[date];
    if (spec.booking_id && allowUpdate && (!existing || existing.booking_id !== spec.booking_id)) throw fail(400, `timebounds.daily.${date}.booking_id ${spec.booking_id} does not match a daily row for that date`);
    const booking_id = spec.booking_id || newBookingId();
    s.rules.daily[date] = { booking_id, is_enabled: spec.is_enabled !== false, bounds: deepClone(spec.bounds || []) };
    note('daily', booking_id);
  }
  for (const k of ['repeat-weekly', 'repeat-daily', 'block']) {
    for (const row of tb[k] || []) {
      const copy = deepClone(row);
      if (copy.booking_id && allowUpdate) {
        const i = s.rules[k].findIndex((x) => x.booking_id === copy.booking_id);
        if (i < 0) throw fail(400, `timebounds.${k}: booking_id ${copy.booking_id} does not exist on this schedule`);
        s.rules[k][i] = { ...s.rules[k][i], ...copy };
      } else {
        copy.booking_id = newBookingId();
        if (k === 'repeat-daily' && copy.is_enabled === undefined) copy.is_enabled = true;
        s.rules[k].push(copy);
      }
      note(k, copy.booking_id);
    }
  }
  return report;
}

function head(s) {
  return {
    schedule_id: s.schedule_id, business_id: s.business_id, name: s.name, archive: s.archive, default: s.default,
    userCreatedDefault: s.userCreatedDefault, config: s.config, createdAt: s.createdAt, updatedAt: s.updatedAt,
  };
}

function findSchedule(id) {
  const s = store.db().schedules[id];
  if (!s) throw fail(404, 'schedule not found');
  return s;
}

function serviceConf(svc, ownerId) {
  return {
    owner_id: ownerId, business_id: store.db().business.business_id, conf_id: svc.conf_id, service_id: svc.service_id,
    duration: svc.duration, price: svc.price, eka_fee: 0, conv_fee: svc.conv_fee, currency: svc.currency, post_pay: svc.post_pay,
    pre_pay: svc.pre_pay, archive: svc.archive, service_name: svc.service_name, book_ahead_days: svc.book_ahead_days,
    allow_patient_booking: svc.allow_patient_booking, nickname: svc.nickname || svc.service_name, followup_validity: svc.followup_validity ?? null,
    appointment_type: svc.appointment_type, mode: svc.mode, book_before_mins: svc.book_before_mins || 0, discount: svc.discount,
    c_at: new Date(svc.created_at * 1000).toISOString(),
  };
}

/** Service-confs for a doctor id, or for every doctor practising at a clinic id. Each item is [svc, ownerId]. */
function confsForEntity(entityId) {
  const d = store.db();
  const doc = store.findDoctor(entityId);
  if (doc) return (d.services[doc.id] || []).map((s) => [s, doc.id]);
  const clinic = store.findClinic(entityId);
  if (clinic) return store.doctorsOfClinic(clinic.id).flatMap((x) => (d.services[x.id] || []).map((s) => [s, x.id]));
  return [];
}

function register(r) {
  // ---------- Create schedule ----------
  r.add('POST', '/schedule', ({ body }) => {
    const b = body || {};
    if (typeof b.name !== 'string' || !b.name.trim()) throw fail(400, 'name is required');
    const durationMode = !!(b.config && b.config.schedule_slot_config_enabled);
    checkConfig(b.config, durationMode);
    const { entityId, locationId } = resolveScope(b);
    checkTimebounds(b.timebounds, { durationMode, entityId, confIds: confIdsOf(entityId) });
    checkProductMap(b.productMap);
    if (b.productMap && Object.values(b.productMap).some(Boolean) && (!entityId || !locationId)) throw fail(400, 'entity_id and location_id are required to assign the schedule to a product');

    const d = store.db();
    const t = isoNow();
    const s = {
      schedule_id: hex(24), business_id: d.business.business_id, name: b.name.trim(), entity_id: entityId, location_id: locationId,
      archive: false, default: false, userCreatedDefault: false, config: normConfig(b.config),
      rules: { weekly: {}, daily: {}, 'repeat-weekly': [], 'repeat-daily': [], block: [] }, products: [], createdAt: t, updatedAt: t,
    };
    applyProducts(s, b.productMap);
    const timebounds = writeTimebounds(s, b.timebounds || {}, { allowUpdate: false });
    d.schedules[s.schedule_id] = s;
    store.save();
    return { status: 201, body: { success: true, data: { ...head(s), timebounds, assignment: { products: s.products }, confs_created: [] } } };
  });

  // ---------- Update schedule ----------
  r.add('PATCH', '/schedule/:scheduleId', ({ params, body }) => {
    const s = findSchedule(params.scheduleId);
    const b = body || {};
    const fields = ['name', 'archive', 'entity_id', 'location_id', 'config', 'timebounds', 'deleteTimebounds', 'productMap'];
    if (!fields.some((k) => b[k] !== undefined)) throw fail(400, `nothing to update; send at least one of ${fields.join(', ')}`);
    if (b.name !== undefined && (typeof b.name !== 'string' || !b.name.trim())) throw fail(400, 'name must be non-empty');
    if (b.archive !== undefined && typeof b.archive !== 'boolean') throw fail(400, 'archive must be a boolean');
    const mutatesRules = b.timebounds !== undefined || b.deleteTimebounds !== undefined || (b.productMap && Object.values(b.productMap).some(Boolean));
    if (b.archive === true && mutatesRules) throw fail(409, 'archive cannot be combined with timebounds, deleteTimebounds or a productMap assignment');
    if (s.archive && b.archive !== false) throw fail(409, 'schedule is archived; unarchive it (archive: false) before changing it');

    const config = normConfig(b.config, s.config);
    checkConfig(b.config, false);
    if (config.schedule_slot_config_enabled && !config.slot_durations.length) throw fail(400, 'config.slot_durations must be non-empty when schedule_slot_config_enabled is true');
    const { entityId, locationId } = resolveScope(b, s);
    checkTimebounds(b.timebounds, { durationMode: config.schedule_slot_config_enabled, entityId, confIds: confIdsOf(entityId) });
    checkProductMap(b.productMap);
    if (b.productMap && (b.entity_id === undefined || b.location_id === undefined)) throw fail(400, 'productMap requires entity_id and location_id in the same request');

    const del = b.deleteTimebounds || {};
    if (typeof del !== 'object' || Array.isArray(del)) throw fail(400, 'deleteTimebounds must be an object');
    for (const k of Object.keys(del)) {
      if (!['daily', 'repeat-weekly', 'repeat-daily', 'block'].includes(k)) throw fail(400, `deleteTimebounds.${k} is not a deletable rule type`);
      if (!Array.isArray(del[k])) throw fail(400, `deleteTimebounds.${k} must be an array of booking_ids`);
    }
    const deleting = new Set(Object.values(del).flat());
    const tb = b.timebounds || {};
    const updating = [...Object.values(tb.daily || {}), ...(tb['repeat-weekly'] || []), ...(tb['repeat-daily'] || []), ...(tb.block || [])].map((x) => x.booking_id).filter(Boolean);
    const clash = updating.find((id) => deleting.has(id));
    if (clash) throw fail(400, `booking_id ${clash} appears in both timebounds and deleteTimebounds`);

    // Work on a copy so a failed step leaves the stored schedule untouched.
    const next = deepClone(s);
    if (b.name !== undefined) next.name = b.name.trim();
    if (b.archive !== undefined) next.archive = b.archive;
    next.entity_id = entityId; next.location_id = locationId; next.config = config;
    applyProducts(next, b.productMap);
    const timebounds = writeTimebounds(next, tb, { allowUpdate: true });

    const deleted = {};
    const failed_tasks = [];
    for (const [k, ids] of Object.entries(del)) {
      for (const id of ids) {
        let hit = false;
        if (k === 'daily') {
          const date = Object.keys(next.rules.daily).find((dt) => next.rules.daily[dt].booking_id === id);
          if (date) { delete next.rules.daily[date]; hit = true; }
        } else {
          const before = next.rules[k].length;
          next.rules[k] = next.rules[k].filter((x) => x.booking_id !== id);
          hit = next.rules[k].length < before;
        }
        if (hit) (deleted[k] = deleted[k] || []).push(id);
        else failed_tasks.push(`delete ${k} ${id}: not found`);
      }
    }
    next.updatedAt = isoNow();
    store.db().schedules[s.schedule_id] = next;
    store.save();
    const data = { ...head(next), timebounds, deleted, assignment: { products: next.products }, confs_created: [] };
    if (failed_tasks.length) data.failed_tasks = failed_tasks;
    return { success: true, data };
  });

  // ---------- Delete schedule ----------
  r.add('DELETE', '/schedule/:scheduleId', ({ params }) => {
    findSchedule(params.scheduleId);
    delete store.db().schedules[params.scheduleId];
    store.save();
    return { success: true };
  });

  // ---------- Resolved schedule ----------
  r.add('GET', '/schedule/resolved', ({ req, query }) => {
    const tz = req.headers['time-zone'] || 'Asia/Kolkata';
    if (!validTimeZone(tz)) throw fail(400, `time-zone ${tz} is not a valid IANA timezone`);
    const entityIds = [...new Set(String(query.entity_id || '').split(',').map((x) => x.trim()).filter(Boolean))];
    if (!entityIds.length) throw fail(400, 'entity_id is required');
    if (entityIds.length > 20) throw fail(400, 'entity_id accepts at most 20 values');
    if (!query.location_id) throw fail(400, 'location_id is required');
    const product = query.product_id || 'product-emr';
    if (!PRODUCTS.includes(product)) throw fail(400, `product_id must be one of ${PRODUCTS.join(', ')}`);
    const start = Date.parse(query.startTime);
    const end = Date.parse(query.endTime);
    if (!query.startTime || !query.endTime || isNaN(start) || isNaN(end)) throw fail(400, 'startTime and endTime are required ISO datetimes');
    if (start >= end) throw fail(400, 'startTime must be before endTime');
    if (end - start > 400 * 86400000) throw fail(400, 'date range cannot exceed 400 days');
    const applyBlock = String(query.applyBlock) === 'true';
    const includeRules = String(query.include_rules) === 'true';

    const clinic = store.findClinic(query.location_id);
    const firstDate = istDate(Math.floor(start / 1000));
    const lastDate = istDate(Math.floor(end / 1000) - 1);
    const data = {};
    for (const eid of entityIds) {
      const doc = store.findDoctor(eid);
      const list = doc && clinic ? Object.values(store.db().schedules).filter((s) => !s.archive && s.entity_id === doc.id && s.location_id === clinic.id && s.products.includes(product)) : [];
      const services = Object.fromEntries((doc ? store.db().services[doc.id] || [] : []).map((x) => [x.conf_id, x]));
      data[eid] = list.map((s) => {
        const schedule = {};
        for (let i = 0; i <= daysBetween(firstDate, lastDate); i++) {
          const date = addDays(firstDate, i);
          const { windows, blocks } = resolveDay(s, date, { applyBlock });
          if (!windows.length && !blocks.length) continue;
          schedule[date] = {
            bounds: windows.map((w) => ({
              s: isoInZone(w.s, tz), e: isoInZone(w.e, tz), source: w.source,
              services: w.conf_ids.map((id) => services[id]).filter(Boolean).map((x) => ({
                conf_id: x.conf_id, name: x.service_name, modes: x.mode.map((m) => (m === 'in-clinic' ? 'clinic' : m)), duration: x.duration ?? null,
              })),
            })),
            blocks: blocks.map((x) => ({ block_id: x.block_id, s: isoInZone(x.s, tz), e: isoInZone(x.e, tz) })),
          };
        }
        const out = { schedule_id: s.schedule_id, name: s.name, schedule_slot_config_enabled: s.config.schedule_slot_config_enabled, slot_durations: s.config.slot_durations, schedule };
        if (includeRules) {
          const today = istDate(now());
          const live = (rows) => rows.filter((x) => !x.end_date || x.end_date >= today);
          out.config = s.config;
          out.rules = { weekly: s.rules.weekly, daily: s.rules.daily, 'repeat-weekly': live(s.rules['repeat-weekly']), 'repeat-daily': live(s.rules['repeat-daily']), block: s.rules.block };
        }
        return out;
      });
    }
    return { success: true, status: 200, data };
  });

  // ---------- Service configurations ----------
  r.add('GET', '/schedule/service-conf/:entityId', ({ params }) => ({
    success: true,
    data: confsForEntity(params.entityId).filter(([s]) => !s.archive).map(([s, owner]) => serviceConf(s, owner)),
    paymentsMeta: { is_elgibile_for_payments: true },
  }));

  r.add('GET', '/schedule/service-conf/:entityId/:conf_id', ({ params }) => {
    const hit = confsForEntity(params.entityId).find(([s]) => s.conf_id === params.conf_id);
    if (!hit) throw new HttpError(404, { success: false });
    return { success: true, data: serviceConf(hit[0], hit[1]) };
  });
}

module.exports = register;
