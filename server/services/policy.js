// ====================================================================
//  POLICY · Single source of truth for rates, caps & eligible modes
// ====================================================================
//  Update this file when HR revises the policy. The frontend reads
//  these values via /api/policy so there is no drift.
// ====================================================================

const POLICY = {
  // ================================================================
  //  BHARAT STEEL (CHENNAI) PVT. LTD.
  //  Ref: Local Conveyance Policy + Travel Expense Reimbursement Policy
  //  Categorisation: monthly remuneration > ₹50,000 = Category 1, else Category 2
  // ================================================================
  bsc: {
    name: 'Bharat Steel (Chennai) Pvt. Ltd.',
    short: 'Bharat Steel',
    hr_email: 'hr@bharatsteels.in',
    cc_emails: ['ea@bharatsteels.in'],
    levels: {
      CAT1: { name: 'Category 1', criteria: 'Monthly remuneration > ₹50,000' },
      CAT2: { name: 'Category 2', criteria: 'Monthly remuneration ≤ ₹50,000' },
    },
    forms: {
      // Local conveyance — own vehicle
      conveyance: {
        title: 'Local Travel Conveyance',
        description: 'Reimbursement for official local travel using personal vehicle.',
        // Rates locked, looked up by vehicle type
        rates: {
          bike: { rate_per_km: 3.5, label: 'Bike / 2-Wheeler' },
          car:  { rate_per_km: 5.0, label: 'Car / 4-Wheeler' },
        },
        rules: [
          'Submit on the 1st of every month for the previous calendar month.',
          'Only official travel directly related to company activities is eligible.',
          'Commute between home and regular office is NOT reimbursable.',
          'Odometer readings or Google Maps distance screenshots are encouraged.',
          'Major discrepancies or false entries may forfeit the entire month\'s claim.',
        ],
      },
      // Outstation expense reimbursement
      expense: {
        title: 'Travel Expense Reimbursement',
        description: 'Outstation business travel — accommodation, food, conveyance & other costs.',
        per_level: {
          CAT1: {
            food_per_day: 750,
            accommodation_per_day: 1500,
            long_distance: ['Train - 3AC', 'Bus - AC Sleeper'],
            local_conveyance: ['Cab/Taxi', 'Auto', 'Bus'],
          },
          CAT2: {
            food_per_day: 500,
            accommodation_per_day: 1000,
            long_distance: ['Train - Sleeper Class', 'Bus - Non-AC Sleeper'],
            local_conveyance: ['Auto', 'Bus'],
          },
        },
        rules: [
          'Claims must be submitted within 5 days from the date of travel.',
          'All claims must be supported with valid, itemised bills / tickets / invoices.',
          'Reimbursements are processed once per month.',
          'Deviations from policy limits require prior written approval.',
        ],
      },
    },
  },

  // ================================================================
  //  METFRAA STEEL BUILDINGS PVT. LTD.
  //  Ref: HR Policy Manual 2026 — Section 04 / Travel, Food, Accommodation & Expense
  //  Levels: L1 (Junior Level) / L2 (Senior Level) / L3 (Managerial Level)
  // ================================================================
  metfraa: {
    name: 'Metfraa Steel Buildings Pvt. Ltd.',
    short: 'Metfraa',
    hr_email: 'admin@metfraa.com',
    cc_emails: [],
    levels: {
      L1: { name: 'L1 — Junior Level',     criteria: 'Categorization is determined solely by the management based on role, responsibilities, experience, and organizational requirements.' },
      L2: { name: 'L2 — Senior Level',     criteria: 'Categorization is determined solely by the management based on role, responsibilities, experience, and organizational requirements.' },
      L3: { name: 'L3 — Managerial Level', criteria: 'Categorization is determined solely by the management based on role, responsibilities, experience, and organizational requirements.' },
    },
    forms: {
      // 1) Local Travel Allowance (own vehicle)
      local: {
        title: 'Local Travel Allowance',
        description: 'Reimbursement for site / official travel using personal vehicle.',
        rates: {
          bike: { rate_per_km: 4,  label: 'Bike / 2-Wheeler' },
          car:  { rate_per_km: 10, label: 'Car / 4-Wheeler' },
        },
        rules: [
          'Includes fuel, maintenance and service costs — no additional vehicle-related expenses reimbursed.',
          'Car / 4-Wheeler travel applies only to journeys of 80 km or more (up and down combined). Shorter distances must use a two-wheeler.',
          'Company car (when allowed up to 80 km/day with prior approval) — taxi reimbursement for local travel is NOT applicable.',
          'Travel plan form and manager approval mandatory 1–2 days in advance.',
          'Travel under 5 km when reporting directly to a different location is NOT eligible.',
        ],
      },
      // 2) Cab Reimbursement
      cab: {
        title: 'Cab Reimbursement',
        description: 'Reimbursement for cab / taxi fare on eligible long-distance local travel.',
        min_km: 80,
        rules: [
          'Applicable only for journeys of 80 km or more (up and down combined). Shorter trips are not eligible.',
          'Attach the cab/taxi bill or receipt for the fare claimed.',
          'For emergencies / late-night travel, document the reason clearly.',
        ],
      },
      // 3) Monthly Accommodation Reimbursement
      accommodation: {
        title: 'Monthly Accommodation Reimbursement',
        description: 'Site accommodation reimbursement — economical accommodation is mandatory.',
        // Daily cap by level
        per_level: {
          L1: { daily_limit: 1000 },
          L2: { daily_limit: 1250 },
          L3: { daily_limit: 1500 },
        },
        rules: [
          'Economical accommodation is mandatory.',
          'Higher limits may be approved for metro cities by management.',
          'Itemised bills / hotel invoices required for every claim.',
          'Submit on or before the 28th of every month.',
        ],
      },
      // 4) Outstation Travel Reimbursement
      outstation: {
        title: 'Outstation Travel Reimbursement',
        description: 'Inter-city official travel — train / bus + food + local conveyance.',
        per_level: {
          L1: { train: 'Sleeper',   bus: 'Sleeper',  food_per_day: 250 },
          L2: { train: 'Sleeper',   bus: 'Sleeper',  food_per_day: 350 },
          L3: { train: '3rd AC',    bus: 'AC Class', food_per_day: 500 },
        },
        site_employee_own_vehicle_rate: 4, // ₹/km — Daily Travel Allowance, Site Employees
        rules: [
          'All reimbursements must be approved by the Reporting Manager prior to submission.',
          'Submit valid bills / invoices — tickets, hotel bills, other invoices.',
          'Submit all claims to HR on or before the 28th of every month.',
          'Reimbursements processed monthly after verification & approval.',
          'Miscellaneous site expenses (materials, tools, labour) require proper recording and prior approval.',
        ],
      },
      // 5) Miscellaneous Reimbursements
      misc: {
        title: 'Miscellaneous Reimbursements',
        description: 'Catch-all for other work-related expenses with supporting bills.',
        rules: [
          'Each item needs a date, purpose and amount.',
          'Attach the bill / receipt for every item.',
          'Use only for expenses not covered by the other forms.',
        ],
      },
      // 6) Travel Advance (upfront cash for an upcoming trip; settled later)
      advance: {
        title: 'Travel Advance Request',
        description: 'Request an upfront amount for an upcoming official trip. Settled after the trip with actual bills.',
        rules: [
          'For upcoming trips only — submit before the travel date.',
          'State the estimated amount and a clear justification (destination, purpose, duration).',
          'Once approved by management, finance will disburse the advance.',
          'After the trip, settle the advance by submitting actual bills via the reimbursement forms — any balance is either returned by the employee or reimbursed to them.',
        ],
      },
    },
  },
};

/* -- helpers ------------------------------------------------------- */

function getCompany(key) {
  return POLICY[key] || null;
}

function getForm(companyKey, formKey) {
  const c = getCompany(companyKey);
  if (!c) return null;
  return c.forms[formKey] || null;
}

function getRate(companyKey, formKey, vehicleType) {
  const f = getForm(companyKey, formKey);
  if (!f || !f.rates) return null;
  return f.rates[vehicleType] || null;
}

function getLevelEntitlement(companyKey, formKey, level) {
  const f = getForm(companyKey, formKey);
  if (!f || !f.per_level) return null;
  return f.per_level[level] || null;
}

// Recipients for a given submission
function getRecipients(companyKey) {
  const c = getCompany(companyKey);
  if (!c) return [];
  return [c.hr_email, ...(c.cc_emails || [])];
}

// What employees can the policy be displayed to without leaking other companies' data?
function publicPolicy(companyKey) {
  const c = getCompany(companyKey);
  if (!c) return null;
  return {
    key: companyKey,
    name: c.name,
    short: c.short,
    levels: c.levels,
    forms: c.forms,
  };
}

module.exports = {
  POLICY,
  getCompany,
  getForm,
  getRate,
  getLevelEntitlement,
  getRecipients,
  publicPolicy,
};
