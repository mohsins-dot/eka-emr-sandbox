/* Endpoint catalogue for the sandbox UI. Loaded in the browser (window.EKA_ENDPOINTS).
 * Grouping and titles follow the Doc Tool section of developer.eka.care.
 * {{name}} placeholders are filled from the page's variables; capture() saves IDs from responses for later calls. */
(function () {
  const DOCS = 'https://developer.eka.care/api-reference/';
  const dt = (p) => DOCS + 'doc-tool/' + p;
  const list = [];
  let group = '';
  const G = (name) => { group = name; };
  const E = (title, method, path, o = {}) => {
    const id = (group + '-' + title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    list.push({ id, group, title, method, path, auth: true, ...o });
  };

  // ---------------- Authorization ----------------
  G('Authorization');
  E('Client login', 'POST', '/connect-auth/v1/account/login', {
    auth: false, docs: DOCS + 'authorization/client-login',
    desc: 'Exchange your client_id and client_secret for an access token (valid 30 minutes) and a refresh token. The page does this for you automatically, but run it here to see the response.',
    body: { client_id: '{{client_id}}', client_secret: '{{client_secret}}' },
    capture: (j, set) => { if (j.access_token) { set('access_token', j.access_token, true); set('refresh_token', j.refresh_token, true); } },
    next: ['business-workspace-get-clinic-and-doctor-details'],
  });
  E('Refresh token', 'POST', '/connect-auth/v1/account/refresh-token', {
    auth: false, docs: DOCS + 'authorization/refresh-token-v2',
    desc: 'Get a new access token with the refresh token from login. Each refresh token works once.',
    headers: [['Authorization', 'Bearer {{access_token}}'], ['Client-Id', '{{client_id}}']],
    body: { refresh_token: '{{refresh_token}}' },
    capture: (j, set) => { if (j.access_token) { set('access_token', j.access_token, true); set('refresh_token', j.refresh_token, true); } },
  });

  // ---------------- Business ----------------
  G('Business & workspace');
  E('Get Workspace Information', 'GET', '/cdr/v1/get_business_info/', { docs: dt('business-api/get-business-info'), desc: 'Returns the business (workspace) ID and name that your credentials belong to.' });
  E('Get Clinic and Doctor details', 'GET', '/dr/v1/business/entities', {
    docs: dt('doctor-and-clinic-api/get-clinic-and-doctor-details'),
    desc: 'Lists every clinic and doctor in the workspace, with Eka IDs and your partner IDs. Start here to find the doctor_id and clinic_id you will book against.',
    next: ['appointment-api-get-appointment-slots', 'patient-registration-add-patient-to-directory'],
  });

  // ---------------- Doctor & clinic ----------------
  G('Doctor & Clinic');
  E('Get Doctor profile', 'GET', '/dr/v1/doctor/{doctor_id}', { docs: dt('doctor-and-clinic-api/get-doctor-profile'), desc: 'Full doctor profile: personal and professional details, specialities and clinics.' });
  E('Get Clinic details', 'GET', '/dr/v1/business/clinic/{clinic_id}', { docs: dt('doctor-and-clinic-api/get-clinic-details'), desc: 'Clinic name and address.' });
  E('Get Doctor services', 'GET', '/dr/v1/doctor/service/{doctor_id}', {
    docs: dt('doctor-and-clinic-api/get-doc-service'), desc: 'Services the doctor offers (in-clinic, tele) with duration, price and conf_id.',
    capture: (j, set) => { const s = ((j.data || {}).services || []).find((x) => (x.mode || []).includes('in-clinic')); if (s) set('conf_id', s.conf_id); },
  });
  E('Get Clinics for doctor', 'GET', '/v1/doctor/clinics/{doctor_id}', { docs: dt('doctor-and-clinic-api/getting-started'), desc: 'Clinics the doctor practises at. Marked work-in-progress in the docs; the response shape here is the sandbox\'s.' });

  // ---------------- HIP users ----------------
  G('User APIs');
  E('Get All HIP Users of a Business', 'GET', '/cdr/v1/hipusers/', { docs: dt('user-apis/get-all-users'), desc: 'All users (staff and admins) in the workspace.' });
  E('Get HIP User Details by ID', 'GET', '/cdr/v1/hipusers/{emr_user_id}', { docs: dt('user-apis/get-user-by-id'), desc: 'One user by Eka ID or partner ID.' });

  // ---------------- Onboarding ----------------
  G('Onboarding');
  const clinicBody = { name: 'My Test Clinic', address: '1 MG Road', pincode: '560001', contact: '9876543210', city: 'Bangalore', state: 'Karnataka', partner_id: 'MY-CLINIC-{{run_id}}' };
  E('Create Clinic', 'POST', '/cdr/v1/clinic/', {
    docs: dt('onboarding-apis/onboard-clinic'), desc: 'Add a clinic with your own partner_id. The new Eka ID is saved as new_clinic_id.', body: clinicBody,
    capture: (j, set) => { if (j.ekaid) set('new_clinic_id', j.ekaid); }, next: ['onboarding-create-doctor-profile'],
  });
  E('List Clinics', 'GET', '/cdr/v1/clinic/', { docs: dt('onboarding-apis/list-clinics'), desc: 'All clinics, with their doctors.' });
  E('Get Clinic by ID', 'GET', '/cdr/v1/clinic/{new_clinic_id}/', { docs: dt('onboarding-apis/get-clinic'), desc: 'Accepts the Eka ID or your partner_id.' });
  E('Update Clinic', 'PATCH', '/cdr/v1/clinic/{new_clinic_id}/', { docs: dt('onboarding-apis/update-clinic'), desc: 'Change any clinic field.', body: { name: 'My Renamed Clinic' } });
  E('Delete Clinic', 'DELETE', '/cdr/v1/clinic/{new_clinic_id}/', { docs: dt('onboarding-apis/delete-clinic'), desc: 'Removes the clinic.' });
  E('Create Doctor Profile', 'POST', '/cdr/v1/doctor/', {
    docs: dt('onboarding-apis/onboard-doctor'), desc: 'Add a doctor and link them to clinics by Eka or partner IDs. The sandbox gives new doctors an in-clinic and a tele service. Saved as new_doctor_id.',
    body: { firstname: 'Asha', lastname: 'Rao', gender: 'F', mobile: '9876500000', email: 'asha@example.com', specialisations: ['Dermatologist'], qualifications: ['MBBS', 'MD'], clinic_ids: ['{{clinic_id}}'], partner_id: 'MY-DOC-{{run_id}}' },
    capture: (j, set) => { if (j.ekaid) set('new_doctor_id', j.ekaid); },
    next: ['schedules-create-schedule'],
  });
  E('List Doctors', 'GET', '/cdr/v1/doctor/', { docs: dt('onboarding-apis/list-doctors'), desc: 'All doctors, with their clinics.' });
  E('Get Doctor by ID', 'GET', '/cdr/v1/doctor/{new_doctor_id}/', { docs: dt('onboarding-apis/get-doctor'), desc: 'Accepts the Eka ID or your partner_id.' });
  E('Update Doctor', 'PATCH', '/cdr/v1/doctor/{new_doctor_id}/', { docs: dt('onboarding-apis/update-doctor'), desc: 'Change any doctor field.', body: { about: 'Consultant dermatologist' } });
  E('Delete Doctor', 'DELETE', '/cdr/v1/doctor/{new_doctor_id}/', { docs: dt('onboarding-apis/delete-doctor'), desc: 'Removes the doctor.' });
  E('Create Eka User', 'POST', '/cdr/v1/ekauser/', {
    docs: dt('onboarding-apis/onboard-ekauser'), desc: 'Add a staff user with access to doctors and clinics. Saved as new_user_id.',
    body: { firstname: 'Front', lastname: 'Office', gender: 'F', dob: '1994-05-05', mobile: '9876511111', is_admin: false, seat_type: 'b', persona: 'S', doctor_ids: ['{{doctor_id}}'], clinic_ids: ['{{clinic_id}}'], partner_id: 'MY-USER-{{run_id}}' },
    capture: (j, set) => { if (j.ekaid) set('new_user_id', j.ekaid); },
  });
  E('List Eka Users', 'GET', '/cdr/v1/ekauser/', { docs: dt('onboarding-apis/list-ekausers'), desc: 'All staff users.' });
  E('Get Eka User by ID', 'GET', '/cdr/v1/ekauser/{new_user_id}/', { docs: dt('onboarding-apis/get-ekauser'), desc: 'Accepts the Eka ID or your partner_id.' });
  E('Update Eka User', 'PATCH', '/cdr/v1/ekauser/{new_user_id}/', { docs: dt('onboarding-apis/update-ekauser'), desc: 'Change any user field.', body: { is_admin: true } });
  E('Delete Eka User', 'DELETE', '/cdr/v1/ekauser/{new_user_id}/', { docs: dt('onboarding-apis/delete-ekauser'), desc: 'Removes the user.' });

  // ---------------- Patient registration ----------------
  G('Patient Registration');
  E('Add Patient to Directory', 'POST', '/dr/v1/patient', {
    docs: dt('patient-registration-api/add-patient-to-directory'), desc: 'Register a patient. Needs first_name, gender and dob (or age). A partner_patient_id that already exists returns 409. The new ID is saved as patient_id.',
    body: { designation: 'Mr.', first_name: 'Test', last_name: 'Patient', gender: 'M', dob: '1987-01-06', mobile: '+918888800001', partner_patient_id: 'MY-PT-{{run_id}}', address: { city: 'Bangalore', pincode: '560049' } },
    capture: (j, set) => { if (j.patient_id) set('patient_id', j.patient_id); },
    next: ['appointment-api-get-appointment-slots'],
  });
  E('Search Patient profiles by mobile number', 'GET', '/dr/v1/business/patients/search', { docs: dt('patient-registration-api/search-patient-by-mobile'), desc: 'Everyone registered with a mobile number. 9999900001 is shared by two seeded patients.', query: [['mobile', '9999900001', '10-digit mobile', true]] });
  E('Get patient details by profile id', 'GET', '/dr/v1/patient/{patient_id}', { docs: dt('patient-registration-api/get-patient-details-by-id'), desc: 'Accepts the Eka ID or partner_patient_id.' });
  E('Update Patient Details', 'PATCH', '/dr/v1/patient/{patient_id}', { docs: dt('patient-registration-api/update-patient-details-api'), desc: 'Change any patient field.', query: [['partner_id', '0', '1 = the path holds partner_patient_id']], body: { last_name: 'Updated', partner_meta: { mrn: 'MRN-1' } } });

  // ---------------- Patient directory ----------------
  G('Patient Directory');
  const cid = { clientId: true };
  E('Create a patient profile', 'POST', '/profiles/v1/patient/', {
    ...cid, docs: dt('patient-directory-apis/add-patient'), desc: 'Create a profile with the short field names (fn, ln, gen, dob). Needs the client-id header. Saved as oid.',
    body: { fn: 'Eka', ln: 'User', s: 'Mr.', dob: '2000-01-02', gen: 'M', bloodgroup: 'A+', mobile: '+916000000000', email: 'user@example.com', username: 'UH{{run_id}}', extras: { source: 'sandbox' } },
    capture: (j, set) => { if (j.oid) set('oid', j.oid); },
  });
  E('Search patient profiles', 'GET', '/profiles/v1/patient/search', { ...cid, docs: dt('patient-directory-apis/search-patient'), desc: 'Prefix search on username, mobile and name.', query: [['prefix', 'aa', 'Start of a name, mobile or username', true], ['limit', '10', 'Max 50']] });
  E('Retrieve patient profile', 'GET', '/profiles/v1/patient/{oid}', { ...cid, docs: dt('patient-directory-apis/retrieve-patient-details'), desc: 'One profile by oid.' });
  E('Update patient profile details', 'PATCH', '/profiles/v1/patient/{oid}', { ...cid, docs: dt('patient-directory-apis/update-patient-details'), desc: 'Change any profile field.', body: { email: 'new@example.com' } });
  E('List patient profiles', 'GET', '/profiles/v1/patient/minified/', { ...cid, docs: dt('patient-directory-apis/patients-list-minified'), desc: 'Paged list of all profiles.', query: [['pageNo', '1', 'Page number', true], ['pageSize', '50', 'Up to 2000'], ['select', 'dob,gen', 'Extra fields']] });
  E('Retrieve patient profiles by mobile number', 'GET', '/profiles/v1/patient/by-mobile/', { ...cid, docs: dt('patient-directory-apis/retrieve-patients-by-mobile'), desc: 'Mobile must include the country code.', query: [['mob', '+919999900002', '+<country code><number>', true], ['full_profile', 'true', '']] });
  E('Retrieve patient profile by username', 'GET', '/profiles/v1/patient/{username}/username/', { ...cid, docs: dt('patient-directory-apis/retrieve-patient-by-username'), desc: 'Seeded usernames are UH0001 to UH0005.', pathDefaults: { username: 'UH0001' }, query: [['flatten', 'true', '']] });
  E('Archive or permanently delete patient profile', 'DELETE', '/profiles/v1/patient/{oid}', { ...cid, docs: dt('patient-directory-apis/delete-patient'), desc: 'Without perm the profile is archived. Send perm=true on an archived profile to delete it for good.', query: [['perm', '', 'true = permanent delete']] });
  E('Retrieve EMR user profile', 'GET', '/profiles/v1/emr-user/{emr_user_id}', { ...cid, docs: dt('patient-directory-apis/retrieve-emr-user'), desc: 'Profile of a staff user or doctor (ps: S).' });
  E('Update EMR user profile', 'PATCH', '/profiles/v1/emr-user/{emr_user_id}', { ...cid, docs: dt('patient-directory-apis/update-emr-user'), desc: 'If fln is sent it is split into fn, mn and ln.', body: { fln: 'Front Desk', bg: 'B+', extras: { preferred_language: 'en' } } });

  // ---------------- Appointments ----------------
  G('Appointment API');
  E('Get Appointment Slots', 'GET', '/dr/v1/doctor/{doctor_id}/clinic/{clinic_id}/appointment/slot', {
    docs: dt('appointment-api/get-appointment-slots'),
    desc: 'Free and booked slots, generated from the doctor\'s product-widget schedule at this clinic. The first available slot is saved as slot_start, which the booking requests use.',
    query: [['start_date', '{{start_date}}', 'YYYY-MM-DD', true], ['end_date', '{{end_date}}', 'YYYY-MM-DD', true]],
    capture: (j, set) => {
      const sched = (j.data || {}).schedule || {};
      const slots = Object.values(sched).flatMap((x) => x.slots || []);
      const s = slots.find((x) => x.available);
      if (s) set('slot_start', String(Math.floor(new Date(s.s).getTime() / 1000)));
    },
    next: ['appointment-api-book-appointment-slot'],
  });
  const bookCapture = (j, set) => { if (j.appointment_id) set('appointment_id', j.appointment_id); };
  E('Book Appointment Slot', 'POST', '/dr/v1/appointment', {
    docs: dt('appointment-api/book-appointment-slot'),
    desc: 'Book with Eka IDs. start_time is epoch seconds (milliseconds are rejected). Fires appointment.created. The new ID is saved as appointment_id.',
    body: { doctor_id: '{{doctor_id}}', clinic_id: '{{clinic_id}}', patient_id: '{{patient_id}}', appointment_details: { start_time: '@{{slot_start}}', end_time: '@{{slot_end}}', mode: 'INCLINIC' }, partner_meta: { encounter_id: '123' }, notes: '<p>Booked from the sandbox</p>' },
    capture: bookCapture,
    next: ['appointment-api-get-appointment-details', 'sandbox-controls-doctor-starts-consult'],
  });
  E('Book Appointment (partner IDs + new patient)', 'POST', '/dr/v1/appointment', {
    docs: dt('appointment-api/book-appointment-slot'),
    desc: 'Book with your own IDs and register the patient in the same call through patient_details.',
    body: { partner_appointment_id: 'PA-{{run_id}}', partner_clinic_id: '{{partner_clinic_id}}', partner_doctor_id: '{{partner_doctor_id}}', partner_patient_id: 'NEW-{{run_id}}', appointment_details: { start_time: '@{{slot_start}}', mode: 'VIDEO', video_connect: { vendor: '100ms', url: 'https://example.com/room' } }, patient_details: { designation: 'Ms.', first_name: 'New', last_name: 'Patient', mobile: '+919000000099', gender: 'F', dob: '1990-01-01' } },
    capture: bookCapture,
  });
  E('Get Appointment Details', 'GET', '/dr/v1/appointment/{appointment_id}', { docs: dt('appointment-api/get-appointment-details'), desc: 'Status, times, payment, prescription link and metadata.', query: [['partner_id', '', '1 = the path holds partner_appointment_id']] });
  E('Get Appointments', 'GET', '/dr/v1/appointment', {
    docs: dt('appointment-api/get-appointments-by-date'), desc: 'Filter by date range (max 7 days) with optional doctor_id or clinic_id, or by patient_id on its own.',
    query: [['doctor_id', '{{doctor_id}}', ''], ['clinic_id', '', ''], ['start_date', '{{start_date}}', 'YYYY-MM-DD'], ['end_date', '{{end_date}}', 'YYYY-MM-DD'], ['patient_id', '', 'Use alone'], ['page_no', '0', '']],
  });
  E('Get all appointments for patient', 'GET', '/dr/v1/appointment/patient/{patient_id}', { docs: dt('appointment-api/getting-started'), desc: 'Every appointment of a patient, newest first, with ISO timestamps.' });
  E('Update Appointment', 'PATCH', '/dr/v1/appointment/{appointment_id}', { docs: dt('appointment-api/update-appointment'), desc: 'Change times, token, notes or metadata. Fires appointment.updated.', body: { token: 3, custom_attributes: { label: ['vitals_submitted'] }, display_meta: { room: '2' } } });
  E('Update Appointment V2', 'PATCH', '/dr/v2/appointment/{appointment_id}', { docs: dt('appointment-api/update-appointment-v2'), desc: 'Also moves the appointment to another doctor or clinic. partner_meta is replaced, not merged.', body: { appointment_details: { mode: 'INCLINIC' }, partner_meta: { encounter_id: '456' } } });
  E('Update Appointment Custom Attributes', 'PATCH', '/dr/v1/appointment/{appointment_id}/custom_attribute', { docs: dt('appointment-api/getting-started'), desc: 'Merge keys into custom_attributes.', query: [['partner_id', '0', '']], body: { payment_status: ['paid'] } });
  E('Reschedule Appointment', 'PATCH', '/appointments/v1/{appointment_id}/reschedule', {
    docs: dt('appointment-api/reschedule-appointment'),
    desc: 'Creates a new appointment at the new time. The old one becomes RES with next_aid; the new one has prev_aids. The new ID is saved as appointment_id.',
    body: { start_time: '@{{slot_plus_1h}}', end_time: '@{{slot_plus_1h15}}' }, capture: bookCapture,
  });
  E('Reschedule Appointment in place (v1)', 'PUT', '/dr/v1/appointment/{appointment_id}/reschedule', { docs: dt('appointment-api/getting-started'), desc: 'Moves the same appointment (and optionally to another doctor or clinic). Only BK and PA appointments.', query: [['partner_id', '0', '']], body: { start_time: '@{{slot_plus_1h}}', end_time: '@{{slot_plus_1h15}}', clinic_id: '{{clinic_id}}', doc_id: '{{doctor_id}}' } });
  E('Parked Appointment', 'POST', '/dr/v1/appointment/{appointment_id}/parked', { docs: dt('appointment-api/parked-appointment'), desc: 'Status becomes PA.', query: [['partner_id', '0', '']] });
  E('Confirm Follow-Up Appointment', 'PUT', '/dr/v1/appointment/{appointment_id}/follow-up/confirm', { docs: dt('appointment-api/confirm-follow-up-appointment'), desc: 'Sets the follow-up time and status BK.', body: { start_time: '@{{follow_up_start}}', end_time: '@{{follow_up_end}}' } });
  E('Complete Appointment', 'POST', '/dr/v1/appointment/{appointment_id}/complete', { docs: dt('appointment-api/complete-appointment'), desc: 'CM if a prescription exists, otherwise CMNP.', query: [['partner_id', '0', '']] });
  E('Cancel Appointment', 'PUT', '/dr/v1/appointment/{appointment_id}/cancel', { docs: dt('appointment-api/cancel-appointment'), desc: 'Status becomes CN. Completed appointments return 403.', query: [['partner_id', '0', '']] });
  E('No-Show Appointment', 'POST', '/dr/v1/appointment/{appointment_id}/change-status', { docs: dt('appointment-api/change-status'), desc: 'Marks a BK or PA appointment as NS.', query: [['partner_id', '0', '']], body: { status: 'NS' } });

  // ---------------- Schedules ----------------
  G('Schedules');
  E('Get Service Conf List', 'GET', '/schedule/service-conf/{doctor_id}', {
    docs: dt('appointment-api/get-service-conf-list'), desc: 'Services of a doctor (or of every doctor at a clinic). The in-clinic conf_id is saved for the schedule requests.',
    capture: (j, set) => { const c = (j.data || []).find((x) => (x.mode || []).includes('in-clinic')); if (c) set('conf_id', c.conf_id); },
  });
  E('Get Service Conf Details', 'GET', '/schedule/service-conf/{doctor_id}/{conf_id}', { docs: dt('appointment-api/get-service-conf-details'), desc: 'One service configuration, archived ones included.' });
  E('Get Resolved Schedule', 'GET', '/schedule/resolved', {
    docs: dt('appointment-api/get-business-resolved-schedule'), desc: 'Availability windows per day. The seeded schedule (product-widget) is what the slot API uses; its ID is saved as schedule_id.',
    headers: [['time-zone', 'Asia/Kolkata']],
    query: [['entity_id', '{{doctor_id}}', 'Comma-separated, max 20', true], ['location_id', '{{clinic_id}}', '', true], ['product_id', 'product-widget', 'product-emr or product-widget'], ['startTime', '{{start_date}}T00:00:00+05:30', 'ISO', true], ['endTime', '{{end_date}}T23:59:59+05:30', 'ISO', true], ['applyBlock', 'true', ''], ['include_rules', 'true', '']],
    capture: (j, set) => { const first = Object.values(j.data || {})[0]; if (first && first[0]) set('schedule_id', first[0].schedule_id); },
    next: ['schedules-update-schedule'],
  });
  E('Create Schedule', 'POST', '/schedule', {
    docs: dt('appointment-api/create-schedule'), desc: 'Service-based schedules need conf_ids the doctor owns; duration-based ones need slot_durations and no conf_ids. Only one product-widget schedule per doctor and clinic. Saved as new_schedule_id.',
    body: { name: 'Evening OPD', entity_id: '{{doctor_id}}', location_id: '{{clinic_id}}', config: { overbooking_limit: 1 }, timebounds: { weekly: { 1: { is_enabled: true, bounds: [{ s: 1800, e: 2100, conf_ids: ['{{conf_id}}'] }] } }, block: [{ start_date: '{{start_date}}', end_date: '{{end_date}}', start_time: '19:00', end_time: '20:00' }] }, productMap: { 'product-emr': true } },
    capture: (j, set) => { if (j.data && j.data.schedule_id) set('new_schedule_id', j.data.schedule_id); },
  });
  E('Update Schedule', 'PATCH', '/schedule/{schedule_id}', {
    docs: dt('appointment-api/update-schedule'),
    desc: 'Edit config and rules. This example blocks 09:00 to 11:00 on start_date in the seeded schedule; check the slot API afterwards. The block ID is saved as block_id.',
    body: { timebounds: { block: [{ start_date: '{{start_date}}', end_date: '{{start_date}}', start_time: '09:00', end_time: '11:00' }] } },
    capture: (j, set) => { const b = ((j.data || {}).timebounds || {}).block; if (b && b[0]) set('block_id', b[0]); },
    next: ['appointment-api-get-appointment-slots'],
  });
  E('Delete Schedule', 'DELETE', '/schedule/{new_schedule_id}', { docs: dt('appointment-api/delete-schedule'), desc: 'Deletes a schedule and all its rules. Uses the schedule you created, not the seeded one.' });

  // ---------------- Prescription / payment / IPD / notify ----------------
  G('Prescription');
  E('Get Prescription details', 'GET', '/dr/v1/prescription/{prescription_id}', { docs: dt('prescription-api/get-prescription-details'), desc: 'Medicines, diagnoses, vitals, advice and PDF links.' });
  G('Payment');
  E('Get Transaction Status', 'GET', '/dr/v1/payment/transaction_status/{transaction_id}', { docs: dt('payment-api/get-transaction-status'), desc: 'Seeded: txn-sandbox-0001 (success), -0002 (failed), -0003 (pending).' });
  G('IPD');
  E('Create IPD Admission', 'POST', '/appointments/v1/ipd/admission', {
    docs: dt('ipd-api/admissions/get-admission'), desc: 'Admit a patient. Saved as admission_id.',
    body: { ipid: 'IPD-{{run_id}}', patient: { id: '{{patient_id}}', profile: { personal: { gender: 'M', name: 'Test Patient', phone: { c: '+91', n: '8888800001' } } } }, doc: { id: '{{doctor_id}}', name: 'Dr. Priya Sharma' }, docid: '{{doctor_id}}', category: { id: 'cat-gen', name: 'General Ward' }, department: { id: 'dept-med', name: 'General Medicine' }, facility: { id: '{{clinic_id}}', name: 'Sandbox Heart & Wellness Clinic' }, bed: 'GW-12', duration: { value: 2, unit: 'days' } },
    capture: (j, set) => { if (j.id) set('admission_id', j.id); },
  });
  E('Get IPD Admission', 'GET', '/appointments/v1/ipd/admission/{admission_id}', { docs: dt('ipd-api/admissions/get-admission'), desc: 'One admission.' });
  G('Notify');
  E('Send Notification', 'POST', '/notification/v1/notify', { docs: dt('notify/notify'), desc: 'Push a notification to a doctor\'s app. landing_page must be q (queue) or a valid page.', body: { partner_payload: { partner_doctor_id: '{{partner_doctor_id}}', message: { title: 'New booking', body: 'A patient booked a slot', img: '' }, landing_page: 'q', params: { action: 'move', aid: '{{appointment_id}}', status: 'confirmed' } } } });

  // ---------------- Webhooks ----------------
  G('Webhooks');
  E('Register Webhook', 'POST', '/notification/v1/connect/webhook/subscriptions', {
    docs: DOCS + 'connect/webhooks/register-webhook', bearer: true,
    desc: 'Subscribe a URL to events. The default endpoint is the sandbox\'s built-in receiver, so you can test without a server; replace it with your own URL. With a signing_key every delivery carries Eka-Webhook-Signature.',
    body: { endpoint: '{{baseUrl}}/_sandbox/webhook-receiver', event_names: ['appointment.created', 'appointment.updated', 'appointment.statuschange', 'prescription.created', 'prescription.updated'], signing_key: 'supersecretkey', protocol: 'http' },
    capture: (j, set) => { if (j.id) set('webhook_id', j.id); },
    next: ['sandbox-controls-fire-test-webhook', 'sandbox-controls-webhook-receiver-inbox'],
  });
  E('Get Webhooks', 'GET', '/notification/v1/connect/webhook/subscriptions', { docs: DOCS + 'connect/webhooks/get-webhooks', bearer: true, desc: 'All registered webhooks.' });
  E('Delete Webhook', 'DELETE', '/notification/v1/connect/webhook/subscriptions/{webhook_id}', { docs: DOCS + 'connect/webhooks/delete-webhook', bearer: true, desc: 'Removes a subscription.' });

  // ---------------- Sandbox controls ----------------
  G('Sandbox controls');
  const sb = { auth: false, sandbox: true };
  E('Doctor starts consult', 'POST', '/_sandbox/appointments/{appointment_id}/start', { ...sb, desc: 'Stands in for the doctor pressing Start in the Eka app: BK becomes OG and webhooks fire.', next: ['sandbox-controls-doctor-writes-prescription'] });
  E('Doctor writes prescription', 'POST', '/_sandbox/appointments/{appointment_id}/prescription', {
    ...sb, desc: 'Creates a sample prescription (or a new version), sets status CM and fires prescription.created. Saved as prescription_id. You can send your own prescription_details array.',
    capture: (j, set) => { if (j.prescription_id) set('prescription_id', j.prescription_id); }, next: ['prescription-get-prescription-details'],
  });
  E('Patient pays', 'POST', '/_sandbox/appointments/{appointment_id}/payment', {
    ...sb, desc: 'Records a transaction on the appointment. Saved as transaction_id.', body: { payment_status: 'PAYMENT_SUCCESS', payment_mode: 'UPI' },
    capture: (j, set) => { if (j.transaction_id) set('transaction_id', j.transaction_id); }, next: ['payment-get-transaction-status'],
  });
  E('Fire test webhook', 'POST', '/_sandbox/webhooks/test', { ...sb, desc: 'Sends any event to every matching subscription.', body: { event: 'appointment.created' }, next: ['sandbox-controls-webhook-deliveries'] });
  E('Webhook deliveries', 'GET', '/_sandbox/webhooks/deliveries', { ...sb, desc: 'Every webhook the sandbox sent: request, headers (with signature), response code and timing.' });
  E('Webhook receiver inbox', 'GET', '/_sandbox/webhook-receiver', { ...sb, desc: 'What the built-in receiver got.' });
  E('Short-lived token', 'POST', '/_sandbox/token', { ...sb, desc: 'An access token that expires in ttl seconds, to test your refresh logic. Not saved; copy it into access_token on the Variables page to use it.', query: [['ttl', '5', 'Seconds']] });
  E('Sandbox info', 'GET', '/_sandbox/info', { ...sb, desc: 'Credentials, seeded IDs and status codes as JSON.' });
  E('Reset sandbox data', 'POST', '/_sandbox/reset', { ...sb, desc: 'Back to the seed data. Clears webhooks, tokens and everything you created.', danger: true });

  window.EKA_ENDPOINTS = list;
})();
