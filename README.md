# Eka Doc Tool Sandbox

A local, stateful mock of the **Eka Care Doc Tool (EMR) APIs**, for building and testing an integration without touching production data.

It serves the same paths, headers and payloads as `https://api.eka.care`. Data you create is stored: book an appointment and it shows up in the slot and list APIs, and a webhook fires. To move to production later, you change only the base URL and credentials.

> **Test data only.** Every doctor, patient, phone number and email in the sandbox is fictional. Nothing you send here reaches Eka.

**Contents:** [Run it](#1-run-it) · [Point your code at it](#2-point-your-code-at-it) · [Test data](#3-seeded-test-data) · [Endpoints](#4-supported-endpoints) · [Doctor-side actions](#5-things-that-happen-on-the-doctors-side) · [Webhooks](#6-webhooks) · [Failure testing](#7-testing-failure-paths) · [Configuration](#8-configuration) · [Differences from production](#9-how-the-sandbox-differs-from-production) · [Going to production](#10-after-testing-going-to-production) · [Project layout](#11-project-layout)

---

## 1. Run it

**Get the code.** Clone the repository, or download it as a ZIP with GitHub's **Code › Download ZIP** button and unzip it.

```bash
git clone https://github.com/mohsins-dot/eka-api-sandbox.git
cd eka-api-sandbox
```

**Start it.** Either option works. Node needs no `npm install`, because the sandbox has zero dependencies.

With Node 18 or newer:

```bash
npm start            # or: node src/index.js
```

With Docker:

```bash
docker compose up --build          # runs in the foreground; Ctrl+C stops it
# or run it in the background:
docker compose up -d --build
docker compose logs -f             # watch requests
docker compose down                # stop it (add -v to also delete the saved data)
```

> **Is Docker stuck on "Attaching to eka-sandbox-1"?** No. The server is running and waiting for requests. If the container was already running, Docker doesn't print the startup banner again. Open http://localhost:4010 to confirm.

Then open **http://localhost:4010**. The dashboard there shows your credentials, the seeded IDs, recent appointments and webhook deliveries.

**Port 4010 already in use?** Start on another port with `PORT=4020 npm start` (PowerShell: `$env:PORT=4020; npm start`).

## 2. Point your code at it

| | Production | Sandbox |
|---|---|---|
| Base URL | `https://api.eka.care` | `http://localhost:4010` |
| client_id | yours | `EC_SANDBOX_001` |
| client_secret | yours | `sandbox_secret_do_not_use_in_prod` |
| Long-lived key | yours | `sandbox_long_lived_api_key` |

```bash
# 1. Get a token
curl -s -X POST http://localhost:4010/connect-auth/v1/account/login \
  -H 'Content-Type: application/json' \
  -d '{"client_id":"EC_SANDBOX_001","client_secret":"sandbox_secret_do_not_use_in_prod"}'

# 2. Call any API with it
curl -s http://localhost:4010/dr/v1/business/entities -H "auth: <access_token>"
```

The sandbox accepts the token in either `auth: <token>` or `Authorization: Bearer <token>`. Access tokens expire after **30 minutes**, the same as in production. Refresh them with `POST /connect-auth/v1/account/refresh-token`.

> **This sandbox or Eka's staging server?** Eka also runs a hosted staging environment at `https://api.dev.eka.care`, which needs staging credentials from Eka. Use this sandbox to build and test on your own machine or in CI: it needs no account, you can reset it, and it lets you play the doctor's side (section 5) and force errors (section 7). Use staging, or a production test workspace, for the final check before going live (section 10).

### Postman

Import `postman/Eka-DocTool-Sandbox.postman_collection.json`. It has 82 requests covering every endpoint, grouped by API. Run **Auth › Login** first; it saves the token for all other requests. The whole collection also runs top to bottom with the Collection Runner or `newman`.

## 3. Seeded test data

These IDs are fixed, so you can hard-code them in your tests. Every entity also has a partner ID, and any API that accepts partner IDs resolves them.

**Doctors**

| doctor_id | partner_id | Name | Clinics |
|---|---|---|---|
| `174159057723920` | `test-doc-123` | Dr. Rahul Kumar (Cardiologist) | CL01, CL02 |
| `174159057723921` | `test-doc-456` | Dr. Priya Sharma (General Physician) | CL01 |
| `174159057723922` | `test-doc-789` | Dr. Arjun Mehta (Pediatrician) | CL02 |

**Clinics**

| clinic_id | partner_id | Name |
|---|---|---|
| `67978400352a61001d64e9fb` | `CL01` | Sandbox Heart & Wellness Clinic, Bangalore |
| `67978400352a61001d64e9fc` | `CL02` | Sandbox Family Care Clinic, Mumbai |

**Patients:** `174678912588401` to `174678912588405` (partner IDs `PT-0001` to `PT-0005`). Mobile `9999900001` is shared by two patients, so you can test family search.

**Other data**

* Appointment `api-sandbox-0000-0000-0000-000000000001` is completed and has prescription `P-DW-SANDBOX-0001`.
* Appointment `…000000000002` is booked for tomorrow.
* Transactions: `txn-sandbox-0001` (success), `txn-sandbox-0002` (failed), `txn-sandbox-0003` (pending).

**Schedules:** each doctor has one schedule per clinic, assigned to both `product-emr` and `product-widget`: Mon–Sat, 09:00–13:00 and 17:00–20:00 IST, for the in-clinic consultation service (15 minutes). Get their IDs from `GET /schedule/resolved`.

**Slots** come from the doctor's `product-widget` schedule at that clinic, so they are 15 minutes each by default. A slot shows as unavailable once it is booked (or once `overbooking_limit` bookings overlap it).

**EMR user:** `176338032692057` (the front-desk user). Doctor IDs also work with the EMR user APIs.

## 4. Supported endpoints

| Area | Endpoints |
|---|---|
| Auth | `POST /connect-auth/v1/account/login`, `POST /connect-auth/v1/account/refresh-token` |
| Workspace | `GET /cdr/v1/get_business_info/`, `GET /dr/v1/business/entities` |
| Doctor & clinic | `GET /dr/v1/doctor/{id}`, `GET /dr/v1/business/clinic/{id}`, `GET /dr/v1/doctor/service/{id}`, `GET /v1/doctor/clinics/{id}` |
| Onboarding | `POST/GET /cdr/v1/doctor/`, `GET/PATCH/DELETE /cdr/v1/doctor/{id}/`; the same for `/cdr/v1/clinic/` and `/cdr/v1/ekauser/` |
| HIP users | `GET /cdr/v1/hipusers/`, `GET /cdr/v1/hipusers/{id}` |
| Patient registration | `POST /dr/v1/patient`, `GET/PATCH /dr/v1/patient/{id}`, `GET /dr/v1/business/patients/search?mobile=` |
| Patient directory | `POST /profiles/v1/patient/`, `GET/PATCH/DELETE /profiles/v1/patient/{oid}`, `GET …/minified/`, `GET …/search`, `GET …/by-mobile/`, `GET …/{username}/username/`, `GET/PATCH /profiles/v1/emr-user/{oid}` (all need the `client-id` header) |
| Appointments | `GET /dr/v1/doctor/{d}/clinic/{c}/appointment/slot`, `POST /dr/v1/appointment`, `GET /dr/v1/appointment`, `GET/PATCH /dr/v1/appointment/{id}`, `PATCH /dr/v2/appointment/{id}`, `PUT …/{id}/cancel`, `POST …/{id}/complete`, `POST …/{id}/parked`, `POST …/{id}/change-status`, `PUT …/{id}/follow-up/confirm`, `PUT …/{id}/reschedule`, `PATCH …/{id}/custom_attribute`, `GET /dr/v1/appointment/patient/{patient_id}`, `PATCH /appointments/v1/{id}/reschedule` |
| Schedules | `POST /schedule`, `PATCH/DELETE /schedule/{id}`, `GET /schedule/resolved`, `GET /schedule/service-conf/{entity_id}`, `GET /schedule/service-conf/{entity_id}/{conf_id}` |
| Prescription | `GET /dr/v1/prescription/{id}` |
| Payments | `GET /dr/v1/payment/transaction_status/{id}` |
| IPD | `POST /appointments/v1/ipd/admission`, `GET /appointments/v1/ipd/admission/{id}` |
| Notify | `POST /notification/v1/notify` |
| Webhooks | `POST/GET /notification/v1/connect/webhook/subscriptions`, `DELETE …/subscriptions/{id}` |

Wherever the real API takes `?partner_id=1`, the sandbox does too. Validation mirrors the docs. For example:

* Booking needs `start_time`, and the time must be in epoch **seconds**; a millisecond value is rejected with a hint.
* The appointment list checks the filter combinations and allows a range of at most 7 days.
* A `partner_*_id` that already exists returns 409.
* The doctor must practise at the clinic being booked.
* Schedules enforce the documented rules. A duration-based schedule (`schedule_slot_config_enabled: true`) needs `slot_durations` and rejects `conf_ids`. A service-based one needs `conf_ids` that the doctor owns. Only one `product-widget` schedule is allowed per doctor and clinic (409). Archiving can't be combined with other changes (409).

### Schedules and slots

A schedule holds rules in IST: `weekly`, `daily`, `repeat-weekly`, `repeat-daily` and `block`. When the sandbox resolves a date, the first rule type that has an entry for it wins, in this order: `daily`, `repeat-daily`, `repeat-weekly`, `weekly`. Blocks are then cut out of the windows.

The slot API reads the doctor's `product-widget` schedule at the clinic. A service-based window is sliced by each service's `duration`, and a duration-based schedule by its first `slot_durations` value. A slot is available until `overbooking_limit` bookings overlap it. So a block, a daily override or a new limit sent with `PATCH /schedule/{id}` shows up straight away in `…/appointment/slot`. A doctor created with the onboarding APIs has no schedule until you create one; until then, slots fall back to `CLINIC_SESSIONS`.

## 5. Things that happen on the doctor's side

In production, a doctor starts a consultation and writes a prescription in the Eka app, and the patient pays. The sandbox has no app, so these endpoints stand in for those actions. They are sandbox-only and need no auth.

| Endpoint | Effect |
|---|---|
| `POST /_sandbox/appointments/{id}/start` | Changes status BK → OG and fires webhooks |
| `POST /_sandbox/appointments/{id}/prescription` | Creates a prescription, or a new version of an existing one. Changes status → CM and fires `prescription.created` or `prescription.updated`. You can pass your own `prescription_details` array. |
| `POST /_sandbox/appointments/{id}/payment` | Records a transaction. Body: `{"payment_status":"PAYMENT_SUCCESS"\|"PAYMENT_FAILED"\|"PAYMENT_PENDING"}`. Check the result with `transaction_status`. |
| `POST /_sandbox/webhooks/test` | Fires any event on demand. Body: `{"event":"appointment.created"}` |
| `GET /_sandbox/webhooks/deliveries` | Every webhook sent, with the request, response code and timing |
| `POST /_sandbox/token?ttl=5` | Issues an access token that expires in 5 s, for testing your refresh logic |
| `POST /_sandbox/reset` | Restores the seed data |
| `GET /_sandbox/info` | Returns credentials and all current IDs as JSON |

**Appointment status lifecycle**

```
BK (booked) ──start──▶ OG (ongoing) ──prescription──▶ CM (completed with Rx)
   │                                   └──complete──▶ CMNP (completed without Rx)
   ├──cancel──▶ CN        ├──change-status NS──▶ NS (no-show)
   ├──parked──▶ PA        └──PATCH reschedule──▶ old becomes RES (next_aid → new), a new BK is created (prev_aids → old)
   └──PUT v1 reschedule──▶ same appointment, new time, stays BK
```

**Status codes.** The sandbox produces `BK`, `PA`, `OG`, `CM`, `CMNP`, `NS`, `CN` and `RES`. Production can also send these codes, which come from actions in the Eka app or from automatic jobs. Handle them in your code even though the sandbox never sends them:

| Code | Meaning |
|---|---|
| `IN` | Initiated: the patient got a follow-up appointment message |
| `AB` | Aborted: started but not completed; set automatically at 12:00 AM the next day |
| `NS` (automatic) | Added to the queue but never started; set automatically at 12:00 AM the next day |
| `NSD` / `NSS` | No-show marked by the doctor / by staff |
| `CND` / `CNS` | Cancelled from the doctor's / staff account |
| `PC` | Provisionally cancelled: the patient said they won't come |
| `PNR` | Payment not received for a pre-paid appointment |
| `RE` / `RED` | Rescheduled via API / from the doctor's account |

## 6. Webhooks

Register your endpoint with the real API:

```bash
curl -X POST http://localhost:4010/notification/v1/connect/webhook/subscriptions \
  -H "Authorization: Bearer <token>" -H 'Content-Type: application/json' \
  -d '{"endpoint":"http://localhost:3000/eka/webhook","event_names":["appointment.created","appointment.updated","appointment.statuschange","prescription.created","prescription.updated"],"signing_key":"supersecretkey"}'
```

**Payloads** use the documented envelope: `service`, `event`, `transaction_id`, `event_time`, `timestamp`, `client_id`, `business_id` and `data`.

**Signing.** When you register a `signing_key`, every request carries `Eka-Webhook-Signature: t=<ts>,v1=<hex>`. The value is HMAC-SHA256 of `"<ts>.<raw body>"`, computed the same way as the production docs describe, so your verification code carries over unchanged.

**Which events fire when**

| Action | Events |
|---|---|
| Book | `appointment.created` |
| Edit | `appointment.updated` |
| Any status change | `appointment.updated` and `appointment.statuschange` |
| Prescription | `prescription.created` or `prescription.updated` |

**Without your own server.** Register `http://localhost:4010/_sandbox/webhook-receiver` as the endpoint, then read the received webhooks at `GET /_sandbox/webhook-receiver`.

**Running in Docker?** `localhost` inside the container is the container itself. Register `http://host.docker.internal:3000/...` instead.

## 7. Testing failure paths

* **Force an error.** Add the header `x-sandbox-force-status: 500` to any API call; 401, 403, 429, 503 and others work the same way.
* **Slow responses.** Start with `LATENCY_MS=1500` to add delay to every API call.
* **Expired tokens.** Use `POST /_sandbox/token?ttl=5`, or start with `ACCESS_TOKEN_TTL=30`.

## 8. Configuration

All settings are environment variables and all are optional.

| Variable | Default | |
|---|---|---|
| `PORT` | `4010` | |
| `EKA_SANDBOX_CLIENT_ID` / `EKA_SANDBOX_CLIENT_SECRET` | see above | |
| `EKA_SANDBOX_API_KEY` | `sandbox_long_lived_api_key` | Accepted directly in `auth` |
| `ACCESS_TOKEN_TTL` / `REFRESH_TOKEN_TTL` | `1800` / `604800` | Seconds |
| `PERSIST` | `true` | `false` keeps data in memory only |
| `DATA_FILE` | `./data/db.json` | Where state is saved |
| `LATENCY_MS` | `0` | |
| `CLINIC_SESSIONS` | `09:00-13:00,17:00-20:00` | Hours used for the seeded schedules, and for slots of doctors with no schedule (IST) |
| `SLOT_MINUTES` | `15` | Slot length for doctors with no schedule |
| `CLOSED_WEEKDAYS` | `0` | 0 = Sunday; comma-separated |
| `LOG_REQUESTS` | `true` | |

`CLINIC_SESSIONS` and `CLOSED_WEEKDAYS` are read when the seed data is created. After changing them, call `POST /_sandbox/reset`, or change the schedules with `PATCH /schedule/{id}`.

## 9. How the sandbox differs from production

* The sandbox is a mock. Shapes and flows follow the public docs at developer.eka.care. The final sign-off for an integration should still be a short run against production with a test workspace.
* **Covered:** the Doc Tool APIs in the table above.
* **Not covered:** the IPD service and SDK APIs (`/ipd/v1/...`; only IPD admission create/get is mocked), `POST /dr/v1/appointment/slots/reserve` (the docs say not to use it), ABDM, EkaScribe, Health AI, Records and MedAssist.
* **Reschedule status.** The docs disagree with themselves here. The status list says `RE` means "rescheduled via API", but the `PATCH /appointments/v1/{id}/reschedule` page says the old appointment becomes `RES`. The sandbox follows the endpoint page (`RES`). Accept both in your code.
* **`PUT /dr/v1/appointment/{id}/reschedule`** is documented only as returning 204. The sandbox moves the same appointment to the new time (and doctor or clinic, if you send them) and fires `appointment.updated`.
* **`GET /v1/doctor/clinics/{id}`** is marked work-in-progress, and the docs show no success body. The sandbox returns `{"data":{"doctor_id","clinics":[…]}}`.
* **Schedule rule precedence** (`daily` over `repeat-daily` over `repeat-weekly` over `weekly`) is the sandbox's reading of the docs, which don't spell it out.
* **Time zones.** Schedules are resolved in IST. `GET /schedule/resolved` honours the `time-zone` header for the timestamps it returns.
* **Prescription URLs** point to `sandbox.eka.invalid` and do not resolve.
* **Single tenant.** There is one workspace, and every token belongs to it.
* **Webhook delivery** is attempted once, with a 5 s timeout, and is not retried.

## 10. After testing: going to production

Once your integration works end to end in the sandbox, follow these steps to move it to production.

1. **Finish testing.** Cover your whole flow: login and token refresh, patients, booking, every status change you handle, webhooks with signature checks, and the error cases in section 7. A clean run of the Postman collection is a good sign-off.
2. **Get production credentials.** Create a `client_id` and `client_secret` at [console.eka.care](https://console.eka.care), or write to ekaconnect@eka.care. Eka sets up your workspace with your real doctors and clinics.
3. **Change configuration, not code.**
   * Base URL `http://localhost:4010` → `https://api.eka.care`
   * Sandbox credentials → your production credentials
   * Seeded test IDs → your real IDs. Get these from `GET /dr/v1/business/entities`, or create doctors and clinics with the onboarding APIs using your own partner IDs.
4. **Remove every `/_sandbox/...` call.** In production, the doctor starts consults and writes prescriptions in the Eka app.
5. **Register your real webhook.** It must be a public HTTPS URL, not `localhost`. If your servers sit behind a firewall, see [IP allowlisting](https://developer.eka.care/api-reference/doc-tool/ip-allowlisting-for-clients).
6. **Run a pilot.** With one real doctor, book one appointment for a test patient and have the doctor complete it. Check that the webhooks and the prescription arrive. This catches the few details a mock can't, such as those listed in section 9.
7. **Go live.** Open the integration to real patients, then stop the sandbox (`Ctrl+C`, or `docker compose down -v`). Keep this repository to reproduce issues later.

## 11. Project layout

```
src/
  index.js            entry point (prints the banner, handles shutdown)
  server.js           HTTP server, auth, error simulation, request log
  config.js           all environment variables and defaults
  seed.js             seeded doctors, clinics, patients, appointments
  store.js            state + persistence to data/db.json
  webhooks.js         delivery and Eka-Webhook-Signature signing
  models.js           response shapes for each API family
  dashboard.js        the page at http://localhost:4010
  schedule.js         schedule rule resolution (used by /schedule/resolved and slots)
  routes/
    auth.js           login, refresh
    patients.js       /dr/v1/patient…, /profiles/v1/patient…, /profiles/v1/emr-user…
    entities.js       business, doctors, clinics, onboarding, HIP users
    appointments.js   slots, booking, lifecycle, reschedule
    schedules.js      /schedule…, service-conf
    other.js          prescription, payments, IPD, notify, webhook subscriptions
    sandbox.js        /_sandbox control endpoints
test/smoke.js         74 end-to-end checks (npm test)
postman/              Postman collection (82 requests)
```

To run the self-check:

```bash
npm test     # starts a throwaway instance and runs 74 end-to-end checks across every route
```

The same tests run automatically on GitHub for every push and pull request (`.github/workflows/test.yml`).

**Adding an endpoint.** Add a route in the matching file under `src/routes/` with `r.add(METHOD, path, handler)`, return the documented response shape, add a request to the Postman collection, and add a check to `test/smoke.js`.

## Support

Questions, or found a difference from production? Open an issue in this repository or write to **ekaconnect@eka.care**. Full API reference: [developer.eka.care](https://developer.eka.care).
