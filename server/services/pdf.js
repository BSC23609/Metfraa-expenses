// ====================================================================
//  PDF SERVICE · branded reports with embedded bill previews
// ====================================================================
//  Generates the final PDF that gets attached to the email and stored
//  in /uploads as the canonical artefact for the submission.
//
//  Layout:
//    Page 1+      : Header (group + company logo) + employee block +
//                   itemised tables + totals + signatures
//    Bill pages   : One page per attachment. Images are rendered at
//                   max width/height. PDFs are listed as "see attached
//                   PDF" (PDFKit can't embed PDF pages without external
//                   libs; we still include the file as part of the
//                   email attachment).
// ====================================================================

const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

// --- design tokens (mirror the frontend theme) -----------------------
const BLUE   = '#1F7CCB';
const BLUE_D = '#155a96';
const INK    = '#0d1421';
const MUTED  = '#6b7689';
const LINE   = '#d6dde6';
const SOFT   = '#eef2f7';
const SUCCESS = '#059669';

const FOOT_HEIGHT = 30;

const GROUP_LOGO = path.join(__dirname, '..', '..', 'public', 'assets', 'group-logo.png');
const COMPANY_LOGOS = {
  bsc:     path.join(__dirname, '..', '..', 'public', 'assets', 'bsc-logo.png'),
  metfraa: path.join(__dirname, '..', '..', 'public', 'assets', 'metfraa-logo.png'),
};

function fmt(n) {
  return Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function formatDate(s) {
  if (!s) return '—';
  const d = new Date(s);
  if (isNaN(d)) return s;
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}
function formatPeriod(s) {
  if (!s) return '—';
  if (s.length === 7) {
    const [y, m] = s.split('-');
    return new Date(parseInt(y), parseInt(m) - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  }
  return s;
}

// ====================================================================

/**
 * Generate a PDF for a submission.
 *
 * @param {Object}   args
 * @param {Object}   args.submission   { reference, form_type, company, period, total_amount, submitted_at }
 * @param {Object}   args.employee     { name, email, employee_code, designation, department, level }
 * @param {Object}   args.payload      form-specific data (from submissions.payload_json)
 * @param {Array}    args.attachments  [{ stored_path, filename, mime_type, category, label }]
 * @param {Object}   args.formMeta     { title, subtitle } resolved from the policy
 * @param {string}   args.outPath      destination .pdf path
 * @returns {Promise<string>}          resolves with outPath when finished
 */
function generatePdf({ submission, employee, payload, attachments = [], formMeta, outPath, suppressAttachments = false }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 80, bottom: 60, left: 50, right: 50 },
        bufferPages: true,
        info: {
          Title: `${formMeta.title} — ${submission.reference}`,
          Author: 'Bharat Steel Group Portal',
          Subject: formMeta.title,
        },
      });

      const stream = fs.createWriteStream(outPath);
      doc.pipe(stream);
      stream.on('finish', () => resolve(outPath));
      stream.on('error', reject);

      // Register bundled DejaVu fonts (they include the ₹ glyph, which the
      // built-in Helvetica lacks) under the standard names, so every
      // existing .font('Helvetica'/'Helvetica-Bold'/'Helvetica-Oblique')
      // call picks them up without change.
      try {
        const FONT_DIR = path.join(__dirname, '..', 'assets', 'fonts');
        const reg = path.join(FONT_DIR, 'DejaVuSans.ttf');
        const bold = path.join(FONT_DIR, 'DejaVuSans-Bold.ttf');
        if (fs.existsSync(reg)) {
          doc.registerFont('Helvetica', reg);
          doc.registerFont('Helvetica-Oblique', reg);
        }
        if (fs.existsSync(bold)) {
          doc.registerFont('Helvetica-Bold', bold);
        }
      } catch (_) { /* fall back to built-in if anything goes wrong */ }

      // -- Page header (every page) ---------------------------------
      const drawHeader = () => {
        const top = 30;
        const left = 50;
        // group logo (left)
        try { doc.image(GROUP_LOGO, left, top, { height: 22 }); } catch (_) {}
        // company logo (right)
        const coLogo = COMPANY_LOGOS[submission.company];
        if (coLogo) { try { doc.image(coLogo, doc.page.width - 50 - 110, top, { fit: [110, 26] }); } catch (_) {} }
        // accent line
        doc.lineWidth(0.5).strokeColor(LINE)
           .moveTo(left, top + 38).lineTo(doc.page.width - 50, top + 38).stroke();
      };

      const drawFooter = () => {
        const y = doc.page.height - FOOT_HEIGHT;
        doc.lineWidth(0.5).strokeColor(LINE)
           .moveTo(50, y).lineTo(doc.page.width - 50, y).stroke();
        doc.fontSize(8).fillColor(MUTED).font('Helvetica')
           .text(
             `Ref ${submission.reference}  ·  Generated ${new Date().toLocaleString('en-IN')}`,
             50, y + 8, { width: doc.page.width - 100, align: 'left' }
           );
        doc.text(`Page ${doc.bufferedPageRange().start + doc.bufferedPageRange().count}`,
          50, y + 8, { width: doc.page.width - 100, align: 'right' });
      };

      doc.on('pageAdded', () => {
        drawHeader();
        // Start content below the header band so it never overlaps, and so
        // PDFKit's auto-flow doesn't cascade into spurious blank pages.
        doc.x = doc.page.margins.left;
        doc.y = 80;
      });

      drawHeader();
      doc.y = 80;

      // -- Title block -----------------------------------------------
      doc.moveDown(2.5);
      doc.fontSize(9).fillColor(MUTED).font('Helvetica')
         .text(formMeta.subtitle || 'EXPENSE SUBMISSION', { characterSpacing: 1.2 });

      doc.fontSize(22).fillColor(INK).font('Helvetica-Bold')
         .text(formMeta.title.toUpperCase(), { characterSpacing: 0.5 });

      doc.fontSize(9).fillColor(MUTED).font('Helvetica')
         .text(`Reference · ${submission.reference}`, { continued: false });

      // -- Employee info card ---------------------------------------
      doc.moveDown(1);
      const infoY = doc.y;
      const infoH = 80;
      doc.rect(50, infoY, doc.page.width - 100, infoH).fillColor(SOFT).fill();
      doc.fillColor(INK);

      const colW = (doc.page.width - 100) / 4;
      const cells = [
        ['NAME',        employee.name || '—'],
        ['EMPLOYEE ID', employee.employee_code || '—'],
        ['DESIGNATION', employee.designation || '—'],
        ['LEVEL',       employee.level || '—'],
        ['DEPARTMENT',  employee.department || '—'],
        ['EMAIL',       employee.email || '—'],
        ['PERIOD',      formatPeriod(submission.period)],
        ['SUBMITTED',   formatDate(submission.submitted_at || new Date().toISOString())],
      ];
      cells.forEach((c, i) => {
        const col = i % 4;
        const row = Math.floor(i / 4);
        const x = 50 + col * colW + 10;
        const y = infoY + 10 + row * 35;
        doc.fontSize(7).fillColor(MUTED).font('Helvetica-Bold')
           .text(c[0], x, y, { characterSpacing: 1.3 });
        doc.fontSize(10).fillColor(INK).font('Helvetica')
           .text(c[1], x, y + 12, { width: colW - 20, ellipsis: true });
      });
      doc.y = infoY + infoH + 20;

      // -- Purpose & Project strip (categorization for the dashboard) ----
      // Drawn for any submission that has it set (i.e. anything filed
      // after the categorization feature went live). Older submissions
      // simply skip this block.
      if (submission.purpose_category || submission.project || submission.client_name) {
        const PURPOSE_NAMES = {
          project_visit:    'Project Visit',
          site_visit:       'Site Visit',
          sales_visit:      'Sales Visit',
          metfraa_office:   'Visit to Metfraa - Office',
          metfraa_factory:  'Visit to Metfraa - Factory',
          purchase_visit:   'Purchase Visit',
        };
        const purposeText = PURPOSE_NAMES[submission.purpose_category] || '—';
        const projectText = submission.project
          ? (submission.project.name + (submission.project.code && submission.project.code !== submission.project.name ? ` (${submission.project.code})` : ''))
          : (submission.client_name ? `${submission.client_name} (Prospect)` : '—');

        const stripY = doc.y;
        const stripH = 36;
        doc.rect(50, stripY, doc.page.width - 100, stripH).fillColor('#eef2ff').fill();
        doc.fillColor(INK);
        const halfW = (doc.page.width - 100) / 2;
        doc.fontSize(7).fillColor(MUTED).font('Helvetica-Bold')
           .text('PURPOSE', 50 + 10, stripY + 6, { characterSpacing: 1.3 });
        doc.fontSize(11).fillColor(INK).font('Helvetica-Bold')
           .text(purposeText, 50 + 10, stripY + 17, { width: halfW - 20, lineBreak: false, ellipsis: true });
        doc.fontSize(7).fillColor(MUTED).font('Helvetica-Bold')
           .text('PROJECT', 50 + halfW + 10, stripY + 6, { characterSpacing: 1.3 });
        doc.fontSize(11).fillColor(INK).font('Helvetica-Bold')
           .text(projectText, 50 + halfW + 10, stripY + 17, { width: halfW - 20, lineBreak: false, ellipsis: true });
        doc.y = stripY + stripH + 16;
      }

      // -- Form-specific body ----------------------------------------
      renderBody(doc, submission, payload, formMeta);

      // -- Grand total banner ----------------------------------------
      if (doc.y > doc.page.height - 200) { doc.addPage(); }
      doc.moveDown(1);
      const banY = doc.y;
      const banH = 56;
      const totalLabel = submission.form_type === 'met_advance'
        ? 'ADVANCE AMOUNT REQUESTED'
        : 'TOTAL REIMBURSEMENT CLAIM';
      doc.rect(50, banY, doc.page.width - 100, banH).fillColor(BLUE).fill();
      doc.fontSize(10).fillColor('white').font('Helvetica')
         .text(totalLabel, 70, banY + 14, { characterSpacing: 1.6 });
      doc.fontSize(22).fillColor('white').font('Helvetica-Bold')
         .text(`₹ ${fmt(submission.total_amount)}`,
            50, banY + 16,
            { width: doc.page.width - 100 - 20, align: 'right' });
      doc.y = banY + banH + 24;

      // -- Signature row: Employee · Checked By · Approved By --------
      if (doc.y > doc.page.height - 160) doc.addPage();
      const sigY = doc.y + 40;
      const gap = 24;
      const sigColW = (doc.page.width - 100 - gap * 2) / 3;
      const cols = [
        { x: 50,                       name: employee.name || '', label: 'EMPLOYEE · DATE' },
        { x: 50 + sigColW + gap,       name: '',                  label: 'CHECKED BY · DATE' },
        { x: 50 + (sigColW + gap) * 2, name: '',                  label: 'APPROVED BY · DATE' },
      ];
      cols.forEach(c => {
        doc.lineWidth(0.7).strokeColor(INK)
           .moveTo(c.x, sigY).lineTo(c.x + sigColW, sigY).stroke();
        if (c.name) {
          doc.fontSize(10).fillColor(INK).font('Helvetica')
             .text(c.name, c.x, sigY + 4, { width: sigColW });
        }
        doc.fontSize(7).fillColor(MUTED).font('Helvetica-Bold')
           .text(c.label, c.x, sigY + 20, { characterSpacing: 1.1, width: sigColW });
      });
      doc.y = sigY + 40;

      // -- Attachments / bills --------------------------------------
      // When the bills will be MERGED into this PDF afterwards (the normal
      // path), skip the report's own placeholder attachment section to
      // avoid duplicate "Supporting Documents" pages and blank-page bloat.
      if (attachments.length && !suppressAttachments) {
        doc.addPage();
        doc.fontSize(9).fillColor(MUTED).font('Helvetica')
           .text('SUPPORTING DOCUMENTS', { characterSpacing: 1.4 });
        doc.fontSize(20).fillColor(INK).font('Helvetica-Bold')
           .text(`Bills & Receipts (${attachments.length})`);
        doc.moveDown(0.5);
        doc.fontSize(10).fillColor(MUTED).font('Helvetica')
           .text('All originals listed below have been uploaded with this submission and form part of the official record.');
        doc.moveDown(1);

        attachments.forEach((att, idx) => {
          renderAttachment(doc, att, idx + 1, attachments.length);
        });
      }

      // -- Finalise with footers on every page ----------------------
      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        // Drawing near the page bottom would otherwise exceed the bottom
        // margin and make PDFKit add a blank page — neutralise the margin
        // for the footer draw.
        const savedBottom = doc.page.margins.bottom;
        doc.page.margins.bottom = 0;
        const y = doc.page.height - FOOT_HEIGHT;
        doc.lineWidth(0.5).strokeColor(LINE)
           .moveTo(50, y).lineTo(doc.page.width - 50, y).stroke();
        doc.fontSize(8).fillColor(MUTED).font('Helvetica')
           .text(`Ref ${submission.reference}  ·  Generated ${new Date().toLocaleString('en-IN')}`,
                 50, y + 8, { width: doc.page.width - 100, align: 'left', lineBreak: false });
        doc.fontSize(8).fillColor(MUTED).font('Helvetica')
           .text(`Page ${i - range.start + 1} of ${range.count}`,
                 50, y + 8, { width: doc.page.width - 100, align: 'right', lineBreak: false });
        doc.page.margins.bottom = savedBottom;
      }
      doc.flushPages();

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// ====================================================================
//  Body rendering — branches per form type
// ====================================================================
function renderBody(doc, sub, payload, formMeta) {
  switch (sub.form_type) {
    case 'bsc_conveyance':       return renderBscConveyance(doc, payload);
    case 'bsc_expense':          return renderBscExpense(doc, payload);
    case 'met_local':            return renderMetLocal(doc, payload);
    case 'met_cab':              return renderMetCab(doc, payload);
    case 'met_accommodation':    return renderMetAccommodation(doc, payload);
    case 'met_outstation':       return renderMetOutstation(doc, payload);
    case 'met_misc':             return renderMetMisc(doc, payload);
    case 'met_advance':          return renderMetAdvance(doc, payload);
    case 'met_dtr':              return renderMetDtr(doc, payload, sub);
    default:
      doc.fontSize(11).fillColor(INK).text(JSON.stringify(payload, null, 2));
  }
}

// ---- table helper ---------------------------------------------------
function table(doc, headers, rows, colWidths, opts = {}) {
  const left = 50;
  const right = doc.page.width - 50;
  const totalW = right - left;
  let widths = colWidths || headers.map(() => totalW / headers.length);
  // Normalise: scale the requested widths so they always sum to exactly the
  // available table width. This guarantees the last column (often the amount)
  // never spills outside the right edge, regardless of the numbers passed in.
  const sum = widths.reduce((a, b) => a + b, 0);
  if (sum > 0 && Math.abs(sum - totalW) > 0.5) {
    widths = widths.map(w => w * totalW / sum);
  }
  const ROW_PAD = 6;

  // ensure room for at least one row
  if (doc.y + 60 > doc.page.height - FOOT_HEIGHT - 50) doc.addPage();

  // header row
  let y = doc.y;
  doc.rect(left, y, totalW, 22).fillColor(INK).fill();
  doc.fillColor('white').font('Helvetica-Bold').fontSize(8);
  let x = left + ROW_PAD;
  headers.forEach((h, i) => {
    doc.text(h.toUpperCase(), x, y + 7, { width: widths[i] - ROW_PAD * 2, characterSpacing: 0.8 });
    x += widths[i];
  });
  y += 22;

  // body
  doc.font('Helvetica').fontSize(9).fillColor(INK);
  rows.forEach((r, idx) => {
    // measure tallest cell to set row height
    const heights = r.map((cell, i) => {
      const txt = (cell == null ? '—' : String(cell));
      return doc.heightOfString(txt, { width: widths[i] - ROW_PAD * 2 });
    });
    const rowH = Math.max(18, Math.max(...heights) + ROW_PAD * 2);

    if (y + rowH > doc.page.height - FOOT_HEIGHT - 30) {
      doc.addPage();
      y = doc.y;
    }

    if (idx % 2 === 0) {
      doc.rect(left, y, totalW, rowH).fillColor(SOFT).fill();
      doc.fillColor(INK);
    }

    x = left + ROW_PAD;
    r.forEach((cell, i) => {
      const isNum = opts.numericCols && opts.numericCols.includes(i);
      doc.fillColor(INK).font('Helvetica').fontSize(9)
         .text(cell == null ? '—' : String(cell),
               x, y + ROW_PAD,
               { width: widths[i] - ROW_PAD * 2, align: isNum ? 'right' : 'left' });
      x += widths[i];
    });
    // bottom rule
    doc.lineWidth(0.3).strokeColor(LINE)
       .moveTo(left, y + rowH).lineTo(right, y + rowH).stroke();
    y += rowH;
  });
  doc.y = y + 8;
}

function sectionHeading(doc, text) {
  if (doc.y > doc.page.height - 160) doc.addPage();
  doc.moveDown(0.5);
  doc.fontSize(8).fillColor(BLUE).font('Helvetica-Bold')
     .text(text.toUpperCase(), 50, doc.y, { characterSpacing: 0.4, width: doc.page.width - 100, lineBreak: false, ellipsis: true });
  doc.moveTo(50, doc.y + 2).lineTo(doc.page.width - 50, doc.y + 2)
     .strokeColor(LINE).lineWidth(0.5).stroke();
  doc.moveDown(0.7);
}

function tripBanner(doc, title, dates) {
  if (doc.y > doc.page.height - 140) doc.addPage();
  const y = doc.y;
  doc.rect(50, y, doc.page.width - 100, 22).fillColor(INK).fill();
  doc.fillColor('white').font('Helvetica-Bold').fontSize(10)
     .text(title.toUpperCase(), 60, y + 6, { characterSpacing: 1, continued: false });
  if (dates) {
    doc.fontSize(9).font('Helvetica').fillColor('#9bb6d4')
       .text(dates, 50, y + 6, { width: doc.page.width - 100 - 10, align: 'right' });
  }
  doc.y = y + 28;
}

// ---- BSC: Local Conveyance ----------------------------------------
function renderBscConveyance(doc, p) {
  sectionHeading(doc, `Vehicle — ${p.vehicle_label || p.vehicle_type}  ·  Rate ₹${fmt(p.rate_per_km)}/km`);
  const rows = (p.trips || []).map(t => ([
    formatDate(t.date), t.from, t.to, t.purpose || '—',
    `${fmt(t.km)} KM`, `₹ ${fmt(t.amount)}`
  ]));
  table(doc, ['Date', 'From', 'To', 'Purpose', 'Distance', 'Amount'], rows,
    [70, 95, 95, 130, 65, 70], { numericCols: [4, 5] });
}

// ---- BSC: Outstation Expense (multi-trip) ---------------------------
function renderBscExpense(doc, p) {
  (p.trips || []).forEach((trip, idx) => {
    tripBanner(doc, `Trip ${String(idx + 1).padStart(2, '0')} · ${trip.place}`,
      `${formatDate(trip.from_date)} — ${formatDate(trip.to_date)}`);
    if (trip.purpose) {
      doc.fontSize(9).fillColor(MUTED).font('Helvetica-Oblique')
         .text(`Purpose: ${trip.purpose}`); doc.moveDown(0.3);
    }
    const rows = [];
    ['accommodation', 'food', 'conveyance', 'others'].forEach(cat => {
      (trip.categories[cat] || []).forEach(item => {
        if (!(parseFloat(item.amount) > 0) && !item.desc) return;
        rows.push([
          formatDate(item.date), item.desc || '—',
          cat.charAt(0).toUpperCase() + cat.slice(1),
          `₹ ${fmt(parseFloat(item.amount) || 0)}`
        ]);
      });
    });
    if (rows.length) {
      table(doc, ['Date', 'Description', 'Category', 'Amount'], rows,
        [80, 230, 90, 90], { numericCols: [3] });
    } else {
      doc.fontSize(9).fillColor(MUTED).font('Helvetica-Oblique')
         .text('No expenses logged for this trip.');
    }
  });
}

// ---- Metfraa: Local Travel ----------------------------------------
function renderMetLocal(doc, p) {
  sectionHeading(doc, `Vehicle — ${p.vehicle_label || p.vehicle_type}  ·  Rate ₹${fmt(p.rate_per_km)}/km`);
  const rows = (p.trips || []).map(t => ([
    formatDate(t.date), t.from, t.to, t.purpose || '—',
    `${fmt(t.km)} KM`, `₹ ${fmt(t.amount)}`
  ]));
  table(doc, ['Date', 'From', 'To', 'Purpose', 'Distance', 'Amount'], rows,
    [70, 95, 95, 130, 65, 70], { numericCols: [4, 5] });
}

// ---- Metfraa: Cab Request -----------------------------------------
function renderMetCab(doc, p) {
  sectionHeading(doc, 'Cab Reimbursement — Trips 80 km+');
  const rows = (p.rides || []).map(r => ([
    formatDate(r.date),
    r.pickup, r.drop,
    `${r.km || '—'} km`,
    `₹ ${fmt(parseFloat(r.fare) || 0)}`,
    r.purpose || '—',
  ]));
  table(doc, ['Date', 'Pickup', 'Drop', 'Distance', 'Fare', 'Purpose'], rows,
    [70, 95, 95, 60, 70, 105], { numericCols: [4] });
}

// ---- Metfraa: Miscellaneous Reimbursement -------------------------
function renderMetMisc(doc, p) {
  sectionHeading(doc, `Miscellaneous Reimbursement · ${(p.items || []).length} item(s)`);
  const rows = (p.items || []).map(it => ([
    formatDate(it.date),
    it.purpose || '—',
    `₹ ${fmt(parseFloat(it.amount) || 0)}`,
  ]));
  table(doc, ['Date', 'Purpose', 'Amount'], rows, [90, 290, 95], { numericCols: [2] });
}

// ---- Metfraa: Daily Travel Reimbursement -------------------------
//   Renders the month's daily commute entries as a compact table.
//   Bills (if any) are merged in after this report by pdf-merge — for
//   each entry that had a bill, we show "Bill ✓" in the table.
function renderMetDtr(doc, p, sub) {
  const MODE_LABEL = { bus: 'Bus', bike_taxi: 'Bike Taxi', auto: 'Auto', share_auto: 'Share Auto' };
  const PURPOSE_LABEL = { project_visit: 'Project', site_visit: 'Site', sales_visit: 'Sales', metfraa_office: 'M. Office', metfraa_factory: 'M. Factory', purchase_visit: 'Purchase' };
  const lookup = (sub && sub.project_lookup) || {};
  const entries = Array.isArray(p.entries) ? p.entries : [];

  sectionHeading(doc, `Daily Travel · ${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`);

  const rows = entries.map(e => {
    let project = '—';
    if (e.project_id != null && lookup[e.project_id]) {
      const pr = lookup[e.project_id];
      project = pr.code && pr.code !== pr.name ? `${pr.name} (${pr.code})` : pr.name;
    } else if (e.client_name) {
      project = `${e.client_name} (Prospect)`;
    }
    const bill = e.mode === 'bus' ? '—' : 'Yes';
    return [
      formatDate(e.date),
      MODE_LABEL[e.mode] || e.mode,
      e.from || '—',
      e.to || '—',
      PURPOSE_LABEL[e.purpose_category] || '—',
      project,
      bill,
      `₹ ${fmt(parseFloat(e.fare) || 0)}`,
    ];
  });

  // Widths: Date / Mode / From / To / Purpose / Project / Bill / Fare
  // The table helper normalises these to fit page width.
  table(doc,
    ['Date', 'Mode', 'From', 'To', 'Purpose', 'Project', 'Bill', 'Fare'],
    rows,
    [54, 56, 80, 80, 50, 90, 30, 55],
    { numericCols: [7] }
  );

  // If any entries have remarks, list them after the table (per-row,
  // referenced by date — keeps the main table compact).
  const withRemarks = entries.filter(e => e.remarks);
  if (withRemarks.length) {
    doc.moveDown(0.6);
    doc.fontSize(9).fillColor(MUTED).font('Helvetica-Bold').text('REMARKS', { characterSpacing: 1.3 });
    doc.moveDown(0.3);
    doc.fontSize(9).fillColor(INK).font('Helvetica');
    for (const e of withRemarks) {
      doc.text(`${formatDate(e.date)} — ${e.remarks}`, { width: doc.page.width - 100 });
    }
  }
}

// ---- Metfraa: Travel Advance Request -------------------------------
function renderMetAdvance(doc, p) {
  sectionHeading(doc, 'Travel Advance — Trip Details');
  table(doc, ['Field', 'Detail'],
    [
      ['Destination',     p.destination || '—'],
      ['Travel from',     formatDate(p.travel_from)],
      ['Travel to',       formatDate(p.travel_to)],
      ['Mode of travel',  p.mode || 'Not specified'],
    ],
    [140, 350]
  );
  doc.moveDown(0.8);
  sectionHeading(doc, 'Purpose / Justification');
  doc.fontSize(11).fillColor(INK).font('Helvetica')
     .text(p.purpose || '—', { width: doc.page.width - 100, align: 'left' });
  if (p.notes) {
    doc.moveDown(0.6);
    doc.fontSize(9).fillColor(MUTED).font('Helvetica-Oblique')
       .text('Additional notes: ' + p.notes, { width: doc.page.width - 100 });
  }
  doc.moveDown(0.8);
  doc.fontSize(9).fillColor(MUTED).font('Helvetica-Oblique')
     .text('Settlement: actual bills are to be submitted via the reimbursement forms after the trip. Any balance is returned by the employee, or reimbursed to them, as applicable.',
           { width: doc.page.width - 100 });
}

// ---- Metfraa: Monthly Accommodation -------------------------------
function renderMetAccommodation(doc, p) {
  sectionHeading(doc,
    `Daily Limit (${p.level}) · ₹${fmt(p.daily_limit)} / day  ·  Days claimed: ${(p.entries || []).length}`);
  const rows = (p.entries || []).map(e => {
    const amt = parseFloat(e.amount) || 0;
    const over = amt > p.daily_limit;
    return [
      formatDate(e.date),
      e.location || '—',
      e.hotel || '—',
      e.bill_no || '—',
      `₹ ${fmt(amt)}${over ? ' ⚠' : ''}`,
    ];
  });
  table(doc, ['Date', 'Location', 'Hotel / Stay', 'Bill #', 'Amount'], rows,
    [75, 110, 175, 90, 75], { numericCols: [4] });

  // Note any over-limit
  const over = (p.entries || []).some(e => (parseFloat(e.amount) || 0) > p.daily_limit);
  if (over) {
    doc.moveDown(0.4);
    doc.fontSize(9).fillColor('#b45309').font('Helvetica-Oblique')
       .text(`⚠ One or more entries exceed the daily limit of ₹${fmt(p.daily_limit)} — management approval required.`);
  }
}

// ---- Metfraa: Outstation Travel -----------------------------------
function renderMetOutstation(doc, p) {
  const ent = p.entitlement || {};
  sectionHeading(doc,
    `Level ${p.level} entitlement · Train ${ent.train} · Bus ${ent.bus} · Food up to ₹${fmt(ent.food_per_day)}/day`);

  (p.trips || []).forEach((trip, idx) => {
    tripBanner(doc, `Trip ${String(idx + 1).padStart(2, '0')} · ${trip.place}`,
      `${formatDate(trip.from_date)} — ${formatDate(trip.to_date)}`);
    if (trip.purpose) {
      doc.fontSize(9).fillColor(MUTED).font('Helvetica-Oblique')
         .text(`Purpose: ${trip.purpose}`); doc.moveDown(0.3);
    }
    if (trip.manager_approval) {
      doc.fontSize(9).fillColor(SUCCESS).font('Helvetica')
         .text(`✓ Approved by: ${trip.manager_approval}`); doc.moveDown(0.3);
    }
    const rows = [];
    ['travel', 'accommodation', 'food', 'local_conveyance', 'others'].forEach(cat => {
      (trip.categories[cat] || []).forEach(item => {
        if (!(parseFloat(item.amount) > 0) && !item.desc) return;
        rows.push([
          formatDate(item.date), item.desc || '—',
          ({
            travel: 'Long-distance Travel', accommodation: 'Accommodation',
            food: 'Food', local_conveyance: 'Local Conv.', others: 'Other'
          })[cat],
          `₹ ${fmt(parseFloat(item.amount) || 0)}`
        ]);
      });
    });
    if (rows.length) {
      table(doc, ['Date', 'Description', 'Category', 'Amount'], rows,
        [75, 230, 110, 75], { numericCols: [3] });
    } else {
      doc.fontSize(9).fillColor(MUTED).font('Helvetica-Oblique')
         .text('No expenses logged for this trip.');
    }
  });
}

// ====================================================================
//  Attachments — render each bill on its own page
// ====================================================================
function renderAttachment(doc, att, idx, total) {
  doc.addPage();
  doc.fontSize(8).fillColor(MUTED).font('Helvetica-Bold')
     .text(`BILL ${idx} OF ${total}`, { characterSpacing: 1.4 });
  doc.fontSize(13).fillColor(INK).font('Helvetica-Bold')
     .text(att.label || att.filename);
  doc.fontSize(9).fillColor(MUTED).font('Helvetica')
     .text(`Category: ${(att.category || 'general')} · ${att.mime_type} · ${Math.round(att.size_bytes / 1024)} KB`);
  doc.moveDown(0.8);

  if (/^image\//.test(att.mime_type)) {
    try {
      const absPath = path.isAbsolute(att.stored_path) ? att.stored_path
        : path.join(__dirname, '..', '..', att.stored_path);
      if (fs.existsSync(absPath)) {
        const maxW = doc.page.width - 100;
        const maxH = doc.page.height - 200;
        doc.image(absPath, 50, doc.y, { fit: [maxW, maxH], align: 'center' });
      } else {
        doc.fontSize(10).fillColor('#b45309').font('Helvetica-Oblique')
           .text('Bill image not found on disk.');
      }
    } catch (err) {
      doc.fontSize(10).fillColor('#b45309').font('Helvetica-Oblique')
         .text(`Could not render image: ${err.message}`);
    }
  } else if (att.mime_type === 'application/pdf') {
    doc.rect(50, doc.y, doc.page.width - 100, 80).fillColor(SOFT).fill();
    doc.fontSize(11).fillColor(INK).font('Helvetica-Bold')
       .text('📄 PDF Attachment', 70, doc.y - 70);
    doc.fontSize(10).fillColor(MUTED).font('Helvetica')
       .text(att.filename, 70, doc.y);
    doc.fontSize(9).fillColor(MUTED).font('Helvetica-Oblique')
       .text('The original PDF is included as a separate attachment in the email.', 70, doc.y);
  } else {
    doc.fontSize(10).fillColor(MUTED).font('Helvetica-Oblique')
       .text(`Unsupported preview type: ${att.mime_type}. File is attached to the email.`);
  }
}

module.exports = { generatePdf };
