'use strict';
/** The sandbox portal at http://localhost:4010 (src/ui). The page is static; it calls the sandbox APIs from the browser. */
const fs = require('fs');
const path = require('path');
const config = require('./config');
const store = require('./store');
const { schedulesFor } = require('./schedule');
const { IDS } = require('./seed');
const { now, istDate, istEpoch, addDays } = require('./util');

const UI = path.join(__dirname, 'ui');
const read = (f) => fs.readFileSync(path.join(UI, f), 'utf8');

/** First open clinic day after today (IST). */
function nextOpenDay() {
  let d = addDays(istDate(now()), 1);
  for (let i = 0; i < 7 && config.closedWeekdays.includes(new Date(d + 'T00:00:00Z').getUTCDay()); i++) d = addDays(d, 1);
  return d;
}

/** Starting values for the page's variables, taken from the current data. */
function defaults() {
  const d = store.db();
  const doctorId = IDS.doctors.priya;
  const clinicId = IDS.clinics.bangalore;
  const conf = (d.services[doctorId] || []).find((s) => s.mode.includes('in-clinic'));
  const sched = schedulesFor(doctorId, clinicId, 'product-widget')[0];
  const day = nextOpenDay();
  return {
    conf_id: conf ? conf.conf_id : '', schedule_id: sched ? sched.schedule_id : '',
    start_date: day, end_date: day, slot_start: String(istEpoch(day, 10, 0)),
  };
}

function render() {
  const cfg = { clientId: config.clientId, clientSecret: config.clientSecret, apiKey: config.apiKey, defaults: defaults() };
  return read('index.html').replace('/*__CONFIG__*/null', JSON.stringify(cfg).replace(/</g, '\\u003c'));
}

function endpointsJs() {
  return read('endpoints.js');
}

module.exports = { render, endpointsJs };
