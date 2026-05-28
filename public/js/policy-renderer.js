// ====================================================================
//  POLICY RENDERER · turns a policy object into styled HTML
// ====================================================================
//  Called by app.js when the user opens the "Check Eligibility" page.
//  Highlights the row for the user's level in every per-level table.
// ====================================================================

(function () {
  'use strict';

  function fmt(n) {
    return Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function renderPolicyDoc(container, policy, userLevel) {
    if (!policy) {
      container.innerHTML = '<div class="card">Policy not available.</div>';
      return;
    }

    const isBsc = policy.key === 'bsc';
    const html = isBsc
      ? renderBscPolicy(policy, userLevel)
      : renderMetfraaPolicy(policy, userLevel);

    container.innerHTML = html;
  }

  // ================================================================
  //  BSC policy
  // ================================================================
  function renderBscPolicy(policy, userLevel) {
    const conv = policy.forms.conveyance;
    const exp  = policy.forms.expense;
    const myCat = policy.levels[userLevel];

    return `
      <div class="policy-doc">
        <h2>${escapeHtml(policy.name)} — Travel & Conveyance Policy</h2>
        <div class="subtitle">Effective Policy · Applicable to your category</div>

        <div class="level-explainer">
          <div class="lbl">Your Category</div>
          <div class="value">${escapeHtml(userLevel)} — ${escapeHtml(myCat ? myCat.name : '')}</div>
          <div class="crit">${escapeHtml(myCat ? myCat.criteria : '')}</div>
        </div>

        <h3>1 · Local Travel Conveyance <span class="your-level">Form C</span></h3>
        <p>${escapeHtml(conv.description)}</p>
        <h4>Reimbursement Rates (per kilometre)</h4>
        <table>
          <thead><tr><th>Vehicle</th><th>Rate</th></tr></thead>
          <tbody>
            ${Object.entries(conv.rates).map(([k, r]) =>
              `<tr><td>${escapeHtml(r.label)}</td><td>₹ ${r.rate_per_km} per km</td></tr>`
            ).join('')}
          </tbody>
        </table>
        <h4>Rules</h4>
        <ul>${conv.rules.map(r => `<li>${escapeHtml(r)}</li>`).join('')}</ul>

        <h3>2 · Travel Expense Reimbursement <span class="your-level">Form E</span></h3>
        <p>${escapeHtml(exp.description)}</p>

        <h4>Per Diem Entitlements</h4>
        <table>
          <thead><tr><th>Category</th><th>Food / day</th><th>Accommodation / day</th></tr></thead>
          <tbody>
            ${Object.entries(exp.per_level).map(([k, v]) =>
              `<tr class="${k === userLevel ? 'highlighted' : ''}">
                 <td>${escapeHtml(policy.levels[k] ? policy.levels[k].name : k)}</td>
                 <td>₹ ${fmt(v.food_per_day)}</td>
                 <td>₹ ${fmt(v.accommodation_per_day)}</td>
               </tr>`
            ).join('')}
          </tbody>
        </table>

        <h4>Long-Distance & Local Conveyance — by Category</h4>
        <table>
          <thead><tr><th>Category</th><th>Train / Bus</th><th>Local</th></tr></thead>
          <tbody>
            ${Object.entries(exp.per_level).map(([k, v]) =>
              `<tr class="${k === userLevel ? 'highlighted' : ''}">
                 <td>${escapeHtml(policy.levels[k] ? policy.levels[k].name : k)}</td>
                 <td>${v.long_distance.join(' / ')}</td>
                 <td>${v.local_conveyance.join(' / ')}</td>
               </tr>`
            ).join('')}
          </tbody>
        </table>

        <h4>Rules</h4>
        <ul>${exp.rules.map(r => `<li>${escapeHtml(r)}</li>`).join('')}</ul>
      </div>
    `;
  }

  // ================================================================
  //  Metfraa policy
  // ================================================================
  function renderMetfraaPolicy(policy, userLevel) {
    const local = policy.forms.local;
    const cab   = policy.forms.cab;
    const acc   = policy.forms.accommodation;
    const out   = policy.forms.outstation;
    const myLevel = policy.levels[userLevel];

    return `
      <div class="policy-doc">
        <h2>${escapeHtml(policy.name)} — HR Policy: Travel, Food, Accommodation & Expense</h2>
        <div class="subtitle">Effective Policy · Applicable to your level</div>

        <div class="level-explainer">
          <div class="lbl">Your Level</div>
          <div class="value">${escapeHtml(userLevel)} — ${escapeHtml(myLevel ? myLevel.name : '')}</div>
          <div class="crit">${escapeHtml(myLevel ? myLevel.criteria : '')}</div>
        </div>

        <h3>Level Categorization</h3>
        <table>
          <thead><tr><th>Level</th><th>Designation Range</th></tr></thead>
          <tbody>
            ${Object.entries(policy.levels).map(([k, v]) =>
              `<tr class="${k === userLevel ? 'highlighted' : ''}">
                 <td>${escapeHtml(v.name)}</td><td>${escapeHtml(v.criteria)}</td>
               </tr>`
            ).join('')}
          </tbody>
        </table>

        <h3>1 · Local Travel Allowance <span class="your-level">LTA</span></h3>
        <p>${escapeHtml(local.description)}</p>
        <h4>Reimbursement Rates (per km)</h4>
        <table>
          <thead><tr><th>Vehicle</th><th>Rate</th></tr></thead>
          <tbody>
            ${Object.entries(local.rates).map(([k, r]) =>
              `<tr><td>${escapeHtml(r.label)}</td><td>₹ ${r.rate_per_km} per km</td></tr>`
            ).join('')}
          </tbody>
        </table>
        <h4>Rules</h4>
        <ul>${local.rules.map(r => `<li>${escapeHtml(r)}</li>`).join('')}</ul>

        <h3>2 · Cab Request <span class="your-level">CAB</span></h3>
        <p>${escapeHtml(cab.description)}</p>
        <h4>Rules</h4>
        <ul>${cab.rules.map(r => `<li>${escapeHtml(r)}</li>`).join('')}</ul>

        <h3>3 · Monthly Accommodation Reimbursement <span class="your-level">ACC</span></h3>
        <p>${escapeHtml(acc.description)}</p>
        <h4>Daily Limits by Level</h4>
        <table>
          <thead><tr><th>Level</th><th>Daily Limit</th></tr></thead>
          <tbody>
            ${Object.entries(acc.per_level).map(([k, v]) =>
              `<tr class="${k === userLevel ? 'highlighted' : ''}">
                 <td>${escapeHtml(policy.levels[k] ? policy.levels[k].name : k)}</td>
                 <td>₹ ${fmt(v.daily_limit)} / day</td>
               </tr>`
            ).join('')}
          </tbody>
        </table>
        <h4>Rules</h4>
        <ul>${acc.rules.map(r => `<li>${escapeHtml(r)}</li>`).join('')}</ul>

        <h3>4 · Outstation Travel Reimbursement <span class="your-level">OUT</span></h3>
        <p>${escapeHtml(out.description)}</p>
        <h4>Travel & Food Entitlements by Level</h4>
        <table>
          <thead><tr><th>Level</th><th>Train</th><th>Bus</th><th>Food / day</th></tr></thead>
          <tbody>
            ${Object.entries(out.per_level).map(([k, v]) =>
              `<tr class="${k === userLevel ? 'highlighted' : ''}">
                 <td>${escapeHtml(policy.levels[k] ? policy.levels[k].name : k)}</td>
                 <td>${escapeHtml(v.train)}</td>
                 <td>${escapeHtml(v.bus)}</td>
                 <td>₹ ${fmt(v.food_per_day)}</td>
               </tr>`
            ).join('')}
          </tbody>
        </table>
        <p style="font-size:13px;color:var(--bsg-muted);margin-top:8px;">
          <strong>Site employees</strong> using own vehicle for daily travel allowance: ₹${out.site_employee_own_vehicle_rate}/km.
        </p>
        <h4>Rules</h4>
        <ul>${out.rules.map(r => `<li>${escapeHtml(r)}</li>`).join('')}</ul>
      </div>
    `;
  }

  // Expose
  window.renderPolicyDoc = renderPolicyDoc;
})();
