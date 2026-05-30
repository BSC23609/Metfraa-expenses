// ====================================================================
//  VALIDATORS · server-side check for every form payload
// ====================================================================
//  Never trust the client. Every submitted payload is re-validated
//  here, the totals are re-computed, and the rates are pulled from
//  the policy module (not from the request body).
// ====================================================================

const { getForm, getRate, getLevelEntitlement } = require('./policy');

function isStr(v) { return typeof v === 'string' && v.trim().length > 0; }
function isDate(v) { return isStr(v) && !isNaN(Date.parse(v)); }
function isPositive(v) { const n = parseFloat(v); return !isNaN(n) && n >= 0; }
function isPositiveNonZero(v) { const n = parseFloat(v); return !isNaN(n) && n > 0; }

function err(msg) { return { ok: false, error: msg }; }
function ok(payload, total) { return { ok: true, payload, total }; }

// ---- BSC: Local Conveyance ----------------------------------------
function validateBscConveyance(input, employee) {
  const formMeta = getForm('bsc', 'conveyance');
  if (!formMeta) return err('Policy missing for bsc/conveyance');
  if (!isStr(input.period)) return err('Period required');
  if (!isStr(input.vehicle_type)) return err('Vehicle type required');
  const rate = getRate('bsc', 'conveyance', input.vehicle_type);
  if (!rate) return err('Invalid vehicle type');

  if (!Array.isArray(input.trips) || input.trips.length === 0) return err('At least one trip is required');

  let total = 0;
  const cleanTrips = [];
  for (const t of input.trips) {
    if (!isDate(t.date)) return err('Each trip needs a valid date');
    if (!isStr(t.from)) return err('Each trip needs a "from" location');
    if (!isStr(t.to))   return err('Each trip needs a "to" location');
    const km = parseFloat(t.km);
    if (!(km > 0))      return err('Each trip needs a positive KM value');
    const amount = +(km * rate.rate_per_km).toFixed(2);
    total += amount;
    cleanTrips.push({
      date: t.date,
      from: String(t.from).trim(),
      to: String(t.to).trim(),
      purpose: isStr(t.purpose) ? t.purpose.trim() : '',
      vehicle_reg: isStr(t.vehicle_reg) ? t.vehicle_reg.trim() : '',
      odo_start: isStr(t.odo_start) ? t.odo_start.trim() : '',
      odo_end: isStr(t.odo_end) ? t.odo_end.trim() : '',
      km,
      amount,
    });
  }

  return ok({
    period: input.period,
    vehicle_type: input.vehicle_type,
    vehicle_label: rate.label,
    rate_per_km: rate.rate_per_km,
    vehicle_reg: isStr(input.vehicle_reg) ? input.vehicle_reg.trim() : '',
    trips: cleanTrips,
  }, +total.toFixed(2));
}

// ---- BSC: Outstation Expense --------------------------------------
function validateBscExpense(input, employee) {
  const formMeta = getForm('bsc', 'expense');
  if (!formMeta) return err('Policy missing for bsc/expense');
  if (!isStr(input.period)) return err('Period required');
  if (!Array.isArray(input.trips) || !input.trips.length) return err('At least one trip is required');

  let total = 0;
  const cleanTrips = [];
  for (const trip of input.trips) {
    if (!isStr(trip.place))      return err('Each trip needs a destination');
    if (!isDate(trip.from_date)) return err('Each trip needs a from date');
    if (!isDate(trip.to_date))   return err('Each trip needs a to date');
    if (!isStr(trip.purpose))    return err('Each trip needs a purpose');
    const cats = { accommodation: [], food: [], conveyance: [], others: [] };
    for (const cat of Object.keys(cats)) {
      const items = (trip.categories || {})[cat] || [];
      for (const it of items) {
        const amt = parseFloat(it.amount);
        if (!(amt > 0)) continue; // skip empty rows
        if (!isDate(it.date)) return err(`${cat} entry needs a valid date`);
        cats[cat].push({
          date: it.date,
          desc: isStr(it.desc) ? it.desc.trim() : '',
          amount: +amt.toFixed(2),
        });
        total += amt;
      }
    }
    cleanTrips.push({
      place: trip.place.trim(),
      from_date: trip.from_date,
      to_date: trip.to_date,
      purpose: trip.purpose.trim(),
      categories: cats,
    });
  }

  return ok({
    period: input.period,
    manager: isStr(input.manager) ? input.manager.trim() : '',
    trips: cleanTrips,
  }, +total.toFixed(2));
}

// ---- Metfraa: Local Travel ----------------------------------------
function validateMetLocal(input, employee) {
  const formMeta = getForm('metfraa', 'local');
  if (!formMeta) return err('Policy missing for metfraa/local');
  if (!isStr(input.period)) return err('Period required');
  if (!isStr(input.vehicle_type)) return err('Vehicle type required');
  const rate = getRate('metfraa', 'local', input.vehicle_type);
  if (!rate) return err('Invalid vehicle type');
  if (!Array.isArray(input.trips) || !input.trips.length) return err('At least one trip is required');

  let total = 0;
  const cleanTrips = [];
  for (const t of input.trips) {
    if (!isDate(t.date)) return err('Each trip needs a date');
    if (!isStr(t.from)) return err('Each trip needs a from location');
    if (!isStr(t.to))   return err('Each trip needs a to location');
    const km = parseFloat(t.km);
    if (!(km > 0))      return err('Each trip needs a positive KM value');
    if (km < 5)         return err('Trips under 5 km are not eligible per policy');
    // Car travel is only reimbursable for longer journeys (80 km+).
    const isCar = /car/i.test(input.vehicle_type) || /car/i.test(rate.label || '');
    if (isCar && km < 80) return err(`Car travel is not applicable for trips under 80 km (this trip is ${km} km). Use a two-wheeler for shorter distances.`);
    const amount = +(km * rate.rate_per_km).toFixed(2);
    total += amount;
    cleanTrips.push({
      date: t.date,
      from: t.from.trim(),
      to: t.to.trim(),
      purpose: isStr(t.purpose) ? t.purpose.trim() : '',
      km, amount,
    });
  }
  return ok({
    period: input.period,
    vehicle_type: input.vehicle_type,
    vehicle_label: rate.label,
    rate_per_km: rate.rate_per_km,
    vehicle_reg: isStr(input.vehicle_reg) ? input.vehicle_reg.trim() : '',
    trips: cleanTrips,
  }, +total.toFixed(2));
}

// ---- Metfraa: Cab Reimbursement (fare-based, 80 km+) -------------
function validateMetCab(input, employee) {
  const formMeta = getForm('metfraa', 'cab');
  if (!formMeta) return err('Policy missing for metfraa/cab');
  if (!Array.isArray(input.rides) || !input.rides.length) return err('At least one cab trip is required');
  const MIN_KM = (formMeta.min_km != null) ? formMeta.min_km : 80;
  let total = 0;
  const rides = [];
  for (const r of input.rides) {
    if (!isDate(r.date))   return err('Each cab trip needs a date');
    if (!isStr(r.pickup))  return err('Each cab trip needs a pickup location');
    if (!isStr(r.drop))    return err('Each cab trip needs a drop location');
    if (!isStr(r.purpose)) return err('Each cab trip needs a purpose');
    const km = parseFloat(r.km);
    if (!(km > 0))         return err('Each cab trip needs a positive distance (km)');
    if (km < MIN_KM)       return err(`Cab reimbursement is not applicable for trips under ${MIN_KM} km (this trip is ${km} km).`);
    const fare = parseFloat(r.fare);
    if (!(fare > 0))       return err('Each cab trip needs the fare amount paid (₹)');
    total += fare;
    rides.push({
      date: r.date,
      time: isStr(r.time) ? r.time.trim() : '',
      pickup: r.pickup.trim(),
      drop: r.drop.trim(),
      km,
      fare: +fare.toFixed(2),
      passengers: r.passengers ? String(r.passengers).trim() : '1',
      purpose: r.purpose.trim(),
      notes: isStr(r.notes) ? r.notes.trim() : '',
    });
  }
  return ok({ rides, period: input.period || '' }, +total.toFixed(2));
}

// ---- Metfraa: Monthly Accommodation -------------------------------
function validateMetAccommodation(input, employee) {
  const formMeta = getForm('metfraa', 'accommodation');
  if (!formMeta) return err('Policy missing for metfraa/accommodation');
  const ent = getLevelEntitlement('metfraa', 'accommodation', employee.level);
  if (!ent) return err(`No accommodation policy defined for level ${employee.level}`);

  if (!isStr(input.period)) return err('Period required');
  if (!Array.isArray(input.entries) || !input.entries.length) return err('At least one accommodation entry is required');

  let total = 0;
  const entries = [];
  for (const e of input.entries) {
    if (!isDate(e.date)) return err('Each entry needs a date');
    if (!isStr(e.location)) return err('Each entry needs a location');
    const amt = parseFloat(e.amount);
    if (!(amt > 0)) return err('Each entry needs a positive amount');
    total += amt;
    entries.push({
      date: e.date,
      location: e.location.trim(),
      hotel: isStr(e.hotel) ? e.hotel.trim() : '',
      bill_no: isStr(e.bill_no) ? e.bill_no.trim() : '',
      amount: +amt.toFixed(2),
    });
  }

  return ok({
    period: input.period,
    level: employee.level,
    daily_limit: ent.daily_limit,
    entries,
  }, +total.toFixed(2));
}

// ---- Metfraa: Outstation Travel -----------------------------------
function validateMetOutstation(input, employee) {
  const formMeta = getForm('metfraa', 'outstation');
  if (!formMeta) return err('Policy missing for metfraa/outstation');
  const ent = getLevelEntitlement('metfraa', 'outstation', employee.level);
  if (!ent) return err(`No outstation policy defined for level ${employee.level}`);

  if (!isStr(input.period)) return err('Period required');
  if (!Array.isArray(input.trips) || !input.trips.length) return err('At least one trip is required');

  let total = 0;
  const trips = [];
  for (const trip of input.trips) {
    if (!isStr(trip.place))      return err('Each trip needs a destination');
    if (!isDate(trip.from_date)) return err('Each trip needs a from date');
    if (!isDate(trip.to_date))   return err('Each trip needs a to date');
    if (!isStr(trip.purpose))    return err('Each trip needs a purpose');
    const cats = { travel: [], accommodation: [], food: [], local_conveyance: [], others: [] };
    for (const cat of Object.keys(cats)) {
      const items = (trip.categories || {})[cat] || [];
      for (const it of items) {
        const amt = parseFloat(it.amount);
        if (!(amt > 0)) continue;
        if (!isDate(it.date)) return err(`${cat} entry needs a valid date`);
        cats[cat].push({
          date: it.date,
          desc: isStr(it.desc) ? it.desc.trim() : '',
          amount: +amt.toFixed(2),
        });
        total += amt;
      }
    }
    trips.push({
      place: trip.place.trim(),
      from_date: trip.from_date,
      to_date: trip.to_date,
      purpose: trip.purpose.trim(),
      manager_approval: isStr(trip.manager_approval) ? trip.manager_approval.trim() : '',
      categories: cats,
    });
  }

  return ok({
    period: input.period,
    level: employee.level,
    entitlement: ent,
    trips,
  }, +total.toFixed(2));
}

// ---- Metfraa: Miscellaneous Reimbursement -------------------------
function validateMetMisc(input, employee) {
  if (!Array.isArray(input.items) || !input.items.length) return err('At least one item is required');
  let total = 0;
  const items = [];
  for (const it of input.items) {
    if (!isDate(it.date))    return err('Each item needs a date');
    if (!isStr(it.purpose))  return err('Each item needs a purpose');
    const amount = parseFloat(it.amount);
    if (!(amount > 0))       return err('Each item needs a positive amount (₹)');
    total += amount;
    items.push({ date: it.date, purpose: it.purpose.trim(), amount: +amount.toFixed(2) });
  }
  return ok({ items, period: input.period || '' }, +total.toFixed(2));
}

// ---- Metfraa: Travel Advance Request -------------------------------
function validateMetAdvance(input, employee) {
  const amount = parseFloat(input.amount);
  if (!(amount > 0))                     return err('Estimated advance amount (₹) is required and must be greater than zero.');
  if (!isStr(input.destination))         return err('Destination is required');
  if (!isDate(input.travel_from))        return err('Travel start date is required');
  if (!isDate(input.travel_to))          return err('Travel end date is required');
  if (input.travel_to < input.travel_from) return err('Travel end date must be on or after the start date');
  if (!isStr(input.purpose))             return err('Purpose / justification is required');
  return ok({
    destination: input.destination.trim(),
    travel_from: input.travel_from,
    travel_to:   input.travel_to,
    purpose:     input.purpose.trim(),
    mode:        (input.mode || '').trim() || null,   // optional: train / bus / car / flight / other
    notes:       (input.notes || '').trim() || null,
    amount:      +amount.toFixed(2),
  }, +amount.toFixed(2));
}

const VALIDATORS = {
  bsc_conveyance:    validateBscConveyance,
  bsc_expense:       validateBscExpense,
  met_local:         validateMetLocal,
  met_cab:           validateMetCab,
  met_accommodation: validateMetAccommodation,
  met_outstation:    validateMetOutstation,
  met_misc:          validateMetMisc,
  met_advance:       validateMetAdvance,
};

const FORM_META = {
  bsc_conveyance:    { company: 'bsc',     title: 'Local Travel Conveyance',         subtitle: 'BSC / Form C',  policyForm: 'conveyance' },
  bsc_expense:       { company: 'bsc',     title: 'Travel Expense Reimbursement',    subtitle: 'BSC / Form E',  policyForm: 'expense' },
  met_local:         { company: 'metfraa', title: 'Local Travel Allowance',           subtitle: 'Metfraa / LTA', policyForm: 'local' },
  met_cab:           { company: 'metfraa', title: 'Cab Reimbursement',                subtitle: 'Metfraa / CAB', policyForm: 'cab' },
  met_accommodation: { company: 'metfraa', title: 'Monthly Accommodation Reimbursement', subtitle: 'Metfraa / ACC', policyForm: 'accommodation' },
  met_outstation:    { company: 'metfraa', title: 'Outstation Travel Reimbursement',  subtitle: 'Metfraa / OUT', policyForm: 'outstation' },
  met_misc:          { company: 'metfraa', title: 'Miscellaneous Reimbursement',      subtitle: 'Metfraa / MISC', policyForm: 'misc' },
  met_advance:       { company: 'metfraa', title: 'Travel Advance Request',           subtitle: 'Metfraa / ADV',  policyForm: 'advance' },
};

// Valid purpose categories — fixed list as agreed with the customer
const PURPOSE_CATEGORIES = ['project_visit', 'site_visit', 'sales_visit'];

function validate(formType, input, employee) {
  const v = VALIDATORS[formType];
  if (!v) return err('Unknown form type');
  // ensure the employee's company can submit this form
  const meta = FORM_META[formType];
  if (!meta) return err('Unknown form type');
  if (meta.company !== employee.company) {
    return err(`This form is not available to employees of ${employee.company.toUpperCase()}.`);
  }

  // --- Pull out + validate categorization (purpose + project) ---
  // These fields live on the top-level payload (sent by the client) and
  // are stored in their own DB columns. We strip them from the payload
  // before form-specific validation so each renderer doesn't have to
  // worry about them.
  const purpose = (input && typeof input.purpose_category === 'string') ? input.purpose_category.trim() : '';
  if (!purpose)                                return err('Purpose is required. Please pick Project Visit, Site Visit, or Sales Visit.');
  if (!PURPOSE_CATEGORIES.includes(purpose))   return err('Invalid purpose selection.');

  // project_id: required for project_visit / site_visit; optional for sales_visit
  // (sales visits may be to a prospect — use client_name instead).
  let projectId = null;
  let clientName = null;
  const rawProjectId = input && input.project_id;
  const rawClient    = input && typeof input.client_name === 'string' ? input.client_name.trim() : '';

  if (purpose === 'sales_visit') {
    // Need EITHER a project OR a client name
    if (rawProjectId != null && rawProjectId !== '') {
      const n = parseInt(rawProjectId, 10);
      if (!Number.isFinite(n) || n <= 0) return err('Invalid project selection.');
      projectId = n;
    } else if (rawClient) {
      clientName = rawClient.slice(0, 200);
    } else {
      return err('For a Sales Visit, pick a project or enter the client / prospect name.');
    }
  } else {
    // Project or Site Visit — project is REQUIRED
    if (rawProjectId == null || rawProjectId === '') {
      return err('Please select a Project for this visit.');
    }
    const n = parseInt(rawProjectId, 10);
    if (!Number.isFinite(n) || n <= 0) return err('Invalid project selection.');
    projectId = n;
  }

  // Hand off to the form-specific validator with a CLEAN payload
  // (categorization removed; renderers don't need to see it).
  const cleanInput = { ...input };
  delete cleanInput.purpose_category;
  delete cleanInput.project_id;
  delete cleanInput.client_name;

  const result = v(cleanInput, employee);
  if (!result.ok) return result;

  // Attach categorization to result.meta — the submit route reads these
  // and puts them in the dedicated DB columns.
  result.meta = {
    purpose_category: purpose,
    project_id: projectId,
    client_name: clientName,
  };
  return result;
}

module.exports = { validate, FORM_META, VALIDATORS, PURPOSE_CATEGORIES };
