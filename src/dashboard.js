'use strict';
const config = require('./config');
const store = require('./store');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function table(headers, rows) {
  if (!rows.length) return '<p class="muted">None yet.</p>';
  return `<div class="tw"><table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function render() {
  const d = store.db();
  const base = `http://localhost:${config.port}`;
  const docs = Object.values(d.doctors).filter((x) => !x.deleted);
  const clinics = Object.values(d.clinics).filter((x) => !x.deleted);
  const patients = Object.values(d.patients).filter((x) => !x.arc);
  const appts = Object.values(d.appointments).sort((a, b) => b.created_at - a.created_at).slice(0, 25);
  const t = (e) => new Date(e * 1000).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Eka Doc Tool Sandbox</title>
<style>
:root{--bg:#f7f7fb;--card:#fff;--fg:#1d1b2e;--muted:#6b6880;--line:#e6e4ef;--accent:#5042BD}
@media (prefers-color-scheme:dark){:root{--bg:#141320;--card:#1d1b2e;--fg:#ecebf5;--muted:#a19eb8;--line:#2e2b44;--accent:#9c91ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px}h1{margin:0 0 4px;font-size:22px}h2{font-size:16px;margin:0 0 10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:16px 0}
.muted{color:var(--muted)}code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
pre{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:12px;overflow:auto}
.tw{overflow-x:auto}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);white-space:nowrap}
th{color:var(--muted);font-weight:600}.pill{display:inline-block;padding:1px 8px;border-radius:99px;background:var(--accent);color:#fff;font-size:12px}
a{color:var(--accent)}
</style></head><body><main>
<h1>Eka Doc Tool Sandbox <span class="pill">local</span></h1>
<p class="muted">Stateful mock of the Eka Care Doc Tool APIs. Point your integration at <code>${esc(base)}</code> instead of <code>https://api.eka.care</code>. Test data only.</p>

<div class="card"><h2>Credentials</h2>
<pre>client_id      ${esc(config.clientId)}
client_secret  ${esc(config.clientSecret)}
api key        ${esc(config.apiKey)}   (long-lived; send as the auth header)</pre>
<pre>curl -s -X POST ${esc(base)}/connect-auth/v1/account/login \\
  -H 'Content-Type: application/json' \\
  -d '{"client_id":"${esc(config.clientId)}","client_secret":"${esc(config.clientSecret)}"}'</pre>
</div>

<div class="card"><h2>Doctors</h2>${table(['doctor_id', 'partner_id', 'name', 'clinics'], docs.map((x) => [x.id, x.partner_id, `Dr. ${x.firstname} ${x.lastname}`, x.clinic_ids.join(', ')]))}</div>
<div class="card"><h2>Clinics</h2>${table(['clinic_id', 'partner_id', 'name', 'city'], clinics.map((x) => [x.id, x.partner_id, x.name, x.city]))}</div>
<div class="card"><h2>Patients</h2>${table(['patient_id (oid)', 'partner_patient_id', 'name', 'mobile', 'username'], patients.map((x) => [x.oid, x.partner_patient_id, x.fln, `${x.ccd || ''}${x.mobile || ''}`, x.username]))}</div>
<div class="card"><h2>Latest appointments</h2>${table(['appointment_id', 'partner id', 'status', 'doctor', 'patient', 'start (IST)'], appts.map((a) => [a.appointment_id, a.partner_appointment_id, a.status, a.doctor_id, a.patient_id, t(a.start_time)]))}</div>
<div class="card"><h2>Webhook subscriptions</h2>${table(['id', 'endpoint', 'events'], Object.values(d.webhooks).map((w) => [w.id, w.endpoint, (w.event_names || []).join(', ') || 'all']))}</div>
<div class="card"><h2>Recent webhook deliveries</h2>${table(['sent', 'event', 'endpoint', 'result'], d.deliveries.slice(0, 20).map((x) => [x.sent_at, x.event, x.endpoint, x.response_status || x.error]))}</div>

<div class="card"><h2>Sandbox controls</h2>
<p class="muted">These are not part of the Eka API; they simulate what the doctor does in the Eka app.</p>
<pre>POST /_sandbox/appointments/{id}/start          # BK -> OG
POST /_sandbox/appointments/{id}/prescription   # writes Rx, -> CM, fires prescription.created
POST /_sandbox/appointments/{id}/payment        # {"payment_status":"PAYMENT_SUCCESS"}
POST /_sandbox/webhooks/test                    # {"event":"appointment.created"}
GET  /_sandbox/webhooks/deliveries
POST /_sandbox/token?ttl=5                      # short-lived token to test refresh
POST /_sandbox/reset                            # back to seed data
GET  /_sandbox/info</pre>
<p class="muted">Force any API to fail: add header <code>x-sandbox-force-status: 500</code> (or 401, 403, 429...).</p>
</div>
</main></body></html>`;
}

module.exports = { render };
