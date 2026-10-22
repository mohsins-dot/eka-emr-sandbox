'use strict';
/**
 * Schedule rules and resolution, shared by the /schedule APIs and the appointment slot API.
 *
 * A schedule stores rules in clinic local time (IST): `weekly`, `daily`, `repeat-weekly`, `repeat-daily` and `block`.
 * For a given date the first matching rule type wins, in this order: daily > repeat-daily > repeat-weekly > weekly.
 * Blocks are blackout windows applied on top.
 */
const store = require('./store');
const { istEpoch, daysBetween } = require('./util');

const RULE_TYPES = ['weekly', 'daily', 'repeat-weekly', 'repeat-daily', 'block'];
const PRODUCTS = ['product-emr', 'product-widget'];

/** 930 -> 570 (minutes after midnight) */
function militaryToMinutes(v) {
  return Math.floor(v / 100) * 60 + (v % 100);
}

/** "09:30" -> 570 */
function hhmmToMinutes(s) {
  const [h, m] = String(s).split(':').map(Number);
  return h * 60 + m;
}

function weekday(date) {
  return new Date(date + 'T00:00:00Z').getUTCDay();
}

function inRange(date, start, end) {
  return (!start || date >= start) && (!end || date <= end);
}

function mod(a, n) {
  return ((a % n) + n) % n;
}

/** The day spec ({ is_enabled, bounds }) and its rule type that apply to `date`, or null. */
function daySpec(rules, date) {
  const daily = (rules.daily || {})[date];
  if (daily) return { spec: daily, source: 'daily' };
  for (const r of rules['repeat-daily'] || []) {
    if (inRange(date, r.start_date, r.end_date) && mod(daysBetween(r.anchor_date || r.start_date, date), r.repeat_every) === r.phase_index) {
      return { spec: r, source: 'repeat-daily' };
    }
  }
  for (const r of rules['repeat-weekly'] || []) {
    if (!inRange(date, r.start_date, r.end_date)) continue;
    const phase = (r.phases || [])[mod(Math.floor(daysBetween(r.anchor_date || r.start_date, date) / 7), r.repeat_every)];
    const spec = phase && phase[String(weekday(date))];
    if (spec) return { spec, source: 'repeat-weekly' };
  }
  const weekly = (rules.weekly || {})[String(weekday(date))];
  if (weekly) return { spec: weekly, source: 'weekly' };
  return null;
}

/** Blackout windows on `date`, as [startMin, endMin] in local minutes. */
function dayBlocks(rules, date) {
  return (rules.block || [])
    .filter((b) => inRange(date, b.start_date, b.end_date))
    .map((b) => ({ block_id: b.booking_id, s: b.start_time ? hhmmToMinutes(b.start_time) : 0, e: b.end_time ? hhmmToMinutes(b.end_time) : 1440 }));
}

/** Remove the block intervals from [s, e]; returns the remaining pieces. */
function subtract(s, e, blocks) {
  let pieces = [[s, e]];
  for (const b of blocks) {
    pieces = pieces.flatMap(([a, z]) => {
      if (b.e <= a || b.s >= z) return [[a, z]];
      const out = [];
      if (b.s > a) out.push([a, b.s]);
      if (b.e < z) out.push([b.e, z]);
      return out;
    });
  }
  return pieces;
}

/**
 * Resolve one schedule on one date into windows: [{ s, e, source, conf_ids }] with s/e as epoch seconds.
 * `applyBlock` cuts blackout windows out of the bounds.
 */
function resolveDay(schedule, date, { applyBlock = true } = {}) {
  const hit = daySpec(schedule.rules, date);
  const blocks = dayBlocks(schedule.rules, date);
  const windows = [];
  if (hit && hit.spec.is_enabled !== false) {
    for (const b of hit.spec.bounds || []) {
      const pieces = applyBlock ? subtract(militaryToMinutes(b.s), militaryToMinutes(b.e), blocks) : [[militaryToMinutes(b.s), militaryToMinutes(b.e)]];
      for (const [a, z] of pieces) {
        windows.push({ s: istEpoch(date, Math.floor(a / 60), a % 60), e: istEpoch(date, Math.floor(z / 60), z % 60), source: hit.source, conf_ids: b.conf_ids || [] });
      }
    }
  }
  return {
    windows,
    blocks: blocks.map((b) => ({ block_id: b.block_id, s: istEpoch(date, Math.floor(b.s / 60), b.s % 60), e: istEpoch(date, Math.floor(b.e / 60), b.e % 60) })),
  };
}

/** Live schedules for an entity at a location assigned to a product. */
function schedulesFor(entityId, locationId, product) {
  return Object.values(store.db().schedules || {}).filter((s) => !s.archive && s.entity_id === entityId && s.location_id === locationId && s.products.includes(product));
}

module.exports = { RULE_TYPES, PRODUCTS, militaryToMinutes, hhmmToMinutes, resolveDay, schedulesFor };
