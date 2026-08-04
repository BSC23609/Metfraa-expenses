// ====================================================================
//  Consolidated Report Builder
// ====================================================================
//   Builds ONE navigable PDF per (employee, period) containing:
//     1. Cover page (employee + month + total + generation timestamp)
//     2. Table of Contents — one row per approved submission with an
//        intra-file "Open" link jumping to that submission's block
//     3. Per-submission blocks: the individual approval PDF + attached
//        bills, each page decorated with a "Home" link back to the TOC
//
//   Uses pdf-lib for merging & annotation. PDFKit isn't used here — the
//   cover + TOC pages are built directly with pdf-lib primitives so we
//   don't need a two-stage generate-then-merge flow.
//
//   Turn 2 will overlay HR + Management sign-offs on every page (or as a
//   footer band on the cover). For now the cover just shows the current
//   status ('DRAFT — GENERATED').
// ====================================================================

const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb, PDFName, PDFArray, PDFNumber, PDFString, PDFDict } = require('pdf-lib');

const A4 = { w: 595.28, h: 841.89 };
const MARGIN = 40;

// Colors used throughout — muted, professional, matches the rest of the
// portal's PDFs. RGB values 0..1.
const INK       = rgb(0.05, 0.08, 0.13);
const MUTED     = rgb(0.42, 0.46, 0.54);
const BRAND     = rgb(0.145, 0.388, 0.922);   // ~ #2563eb
const LINE      = rgb(0.84, 0.87, 0.90);
const HOME_BG   = rgb(0.94, 0.95, 0.98);

// Format a number as Indian ₹ with 2 decimals.
function fmtInr(n) {
  const num = parseFloat(n) || 0;
  return num.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Format a date-ish string as "DD MMM YYYY"
function fmtDate(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso.length === 19 && iso[10] === ' ' ? iso.replace(' ', 'T') + 'Z' : iso);
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch (_) { return iso; }
}

// Human-friendly form label
const FORM_LABEL = {
  met_local:         'Local Travel',
  met_cab:           'Cab Reimbursement',
  met_accommodation: 'Accommodation',
  met_outstation:    'Outstation',
  met_misc:          'Miscellaneous',
  met_advance:       'Travel Advance',
  met_dtr:           'Daily Travel',
  bsc_conveyance:    'Conveyance',
  bsc_expense:       'Expense',
};

// Resolve a stored_path (which may be relative to project root) to abs.
function resolveUpload(storedPath) {
  return path.isAbsolute(storedPath) ? storedPath : path.join(__dirname, '..', '..', storedPath);
}

// -----------------------------------------------------------------
// PDF annotation helper — add a clickable rectangle on a page that
// jumps to another page in the same document. pdf-lib doesn't have a
// convenience API for this so we craft the /Annot dictionary directly.
//
// rect: [x1, y1, x2, y2] in the SOURCE page's coordinate system.
//       (0,0) is bottom-left in PDF coordinates.
// targetPage: the pdf-lib PDFPage object to jump to.
// -----------------------------------------------------------------
function addInternalLink(sourcePage, targetPage, rect) {
  const context = sourcePage.doc.context;
  // /Dest = [targetPageRef /XYZ x y zoom]  — XYZ places the top-left of
  // the view at (x,y) with zoom (null = keep zoom). We land at the top
  // of the target page.
  const targetPageRef = targetPage.ref;
  const dest = PDFArray.withContext(context);
  dest.push(targetPageRef);
  dest.push(PDFName.of('XYZ'));
  dest.push(PDFName.of('null'));  // keep left
  dest.push(PDFNumber.of(A4.h));  // top of the target page
  dest.push(PDFName.of('null'));  // keep zoom

  const linkDict = context.obj({
    Type:    'Annot',
    Subtype: 'Link',
    Rect:    rect,
    Border:  [0, 0, 0],   // no visible border — the styled text carries the affordance
    Dest:    dest,
  });
  const linkRef = context.register(linkDict);

  // Attach to the page. pdf-lib's Annots() lookup returns undefined if
  // no /Annots key exists on the node — we ALWAYS need to write it back
  // after pushing, even if we found an existing array, because the
  // page-node accessor doesn't automatically persist mutations.
  let annots = sourcePage.node.Annots();
  if (!annots) {
    annots = context.obj([]);
  }
  annots.push(linkRef);
  sourcePage.node.set(PDFName.of('Annots'), annots);
}

// Draw a subtle "🏠 Home" pill in the top-right of a page and register
// it as a clickable annotation pointing to `tocPage`. Used on every
// non-cover, non-TOC page.
function drawHomeLink(page, tocPage, font) {
  const { width, height } = page.getSize();
  const label = 'HOME  ^';
  const size = 8;
  const textW = font.widthOfTextAtSize(label, size);
  const pillW = textW + 16;
  const pillH = 16;
  const x = width - MARGIN - pillW;
  const y = height - MARGIN + 4;    // sits just below the top margin

  // pill background
  page.drawRectangle({
    x, y, width: pillW, height: pillH,
    color: HOME_BG,
    borderColor: LINE,
    borderWidth: 0.5,
    borderOpacity: 1,
  });
  page.drawText(label, {
    x: x + 8, y: y + 4.5,
    size, font, color: BRAND,
  });

  // clickable rect
  addInternalLink(page, tocPage, [x, y, x + pillW, y + pillH]);
}

// -----------------------------------------------------------------
// Cover page
// -----------------------------------------------------------------
function drawCover({ page, font, fontBold, employee, period, total, submissionCount, generatedAt, signoffs }) {
  const { width, height } = page.getSize();

  // Brand strip at top
  page.drawRectangle({ x: 0, y: height - 6, width, height: 6, color: BRAND });

  // Category label
  page.drawText('CONSOLIDATED REPORT', {
    x: MARGIN, y: height - 90,
    size: 9, font: fontBold, color: MUTED,
  });

  // Big title: month + year
  const monthLabel = new Date(period + '-01').toLocaleDateString('en-IN', {
    month: 'long', year: 'numeric', timeZone: 'UTC',
  });
  page.drawText(monthLabel, {
    x: MARGIN, y: height - 130,
    size: 32, font: fontBold, color: INK,
  });

  // Employee block
  page.drawLine({
    start: { x: MARGIN, y: height - 180 }, end: { x: width - MARGIN, y: height - 180 },
    thickness: 0.5, color: LINE,
  });
  page.drawText('EMPLOYEE', { x: MARGIN, y: height - 205, size: 8, font: fontBold, color: MUTED });
  page.drawText(employee.name || '—', { x: MARGIN, y: height - 226, size: 15, font: fontBold, color: INK });
  page.drawText(`${employee.email || ''}${employee.code ? '  ·  ' + employee.code : ''}${employee.company ? '  ·  ' + String(employee.company).toUpperCase() : ''}`, {
    x: MARGIN, y: height - 243, size: 9, font, color: MUTED,
  });

  // Total block on the right. If the total is negative (settlement
  // shortfalls exceed reimbursements), we flip the label to "PAYABLE
  // TO COMPANY" and draw the amount unsigned (with a small arrow). This
  // makes the direction of the money obvious to Arasu and Accounts
  // without them having to parse the sign.
  const totalIsNegative = Number(total) < 0;
  const displayTotal = Math.abs(Number(total) || 0);
  const totalLabel = totalIsNegative ? 'PAYABLE TO COMPANY' : 'PAYABLE TO EMPLOYEE';
  const totalStr = `INR ${fmtInr(displayTotal)}`;
  const totalColor = totalIsNegative ? rgb(0.72, 0.16, 0.16) : INK;
  const totalX = width - MARGIN - 240;
  page.drawText(totalLabel, { x: totalX, y: height - 205, size: 8, font: fontBold, color: MUTED });
  page.drawText(totalStr, { x: totalX, y: height - 235, size: 22, font: fontBold, color: totalColor });
  page.drawText(`${submissionCount} claim${submissionCount === 1 ? '' : 's'}${totalIsNegative ? '  ·  net owed back' : ''}`, {
    x: totalX, y: height - 253, size: 9, font, color: MUTED,
  });

  page.drawLine({
    start: { x: MARGIN, y: height - 280 }, end: { x: width - MARGIN, y: height - 280 },
    thickness: 0.5, color: LINE,
  });

  // Status band — reflects whichever approvals have been recorded.
  // signoffs is an optional {hr:{by,at}, mgmt:{by,at}} object.
  const so = signoffs || {};
  page.drawText('STATUS', { x: MARGIN, y: height - 310, size: 8, font: fontBold, color: MUTED });
  let statusLabel, statusColor;
  if (so.mgmt && so.mgmt.by) {
    statusLabel = 'APPROVED — READY FOR PAYMENT';
    statusColor = rgb(0.02, 0.5, 0.35);
  } else if (so.hr && so.hr.by) {
    statusLabel = 'HR VERIFIED — AWAITING MANAGEMENT';
    statusColor = rgb(0.145, 0.388, 0.922);
  } else {
    statusLabel = 'DRAFT — AWAITING REVIEW';
    statusColor = rgb(0.7, 0.4, 0.05);
  }
  page.drawText(statusLabel, { x: MARGIN, y: height - 328, size: 12, font: fontBold, color: statusColor });

  // Sign-off rows — only draw when the corresponding approval exists.
  // Stacked vertically below the status. Each row: LABEL · name · datetime IST.
  let sigY = height - 356;
  const drawSig = (label, meta) => {
    if (!meta || !meta.by) return;
    page.drawText(label, { x: MARGIN, y: sigY, size: 8, font: fontBold, color: MUTED });
    const nameStr = (meta.by || '').split('@')[0];
    const dtStr = fmtDateTimeIst(meta.at);
    page.drawText(`${nameStr}  ·  ${dtStr}`, { x: MARGIN + 90, y: sigY, size: 10, font: fontBold, color: INK });
    sigY -= 18;
  };
  drawSig('HR VERIFIED',      so.hr);
  drawSig('MGMT APPROVED',    so.mgmt);

  // Footer
  page.drawText(`Generated ${fmtDate(generatedAt)}`, {
    x: MARGIN, y: 40, size: 8, font, color: MUTED,
  });
  page.drawText('METFRAA · EXPENSE PORTAL · CONSOLIDATED', {
    x: MARGIN, y: 28, size: 7, font: fontBold, color: MUTED,
  });
}

// Format a datetime for the sign-off rows: "02 Aug 2026 01:12 AM IST"
function fmtDateTimeIst(iso) {
  if (!iso) return '—';
  try {
    // SQLite returns 'YYYY-MM-DD HH:MM:SS' UTC — normalise
    const parseable = typeof iso === 'string' && iso.length === 19 && iso[10] === ' '
      ? iso.replace(' ', 'T') + 'Z'
      : iso;
    const d = new Date(parseable);
    if (isNaN(d)) return String(iso);
    // Convert to IST for display
    const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
    const datePart = ist.toLocaleDateString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC',
    });
    const timePart = ist.toLocaleTimeString('en-IN', {
      hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'UTC',
    });
    return `${datePart} ${timePart} IST`;
  } catch (_) { return String(iso); }
}

// -----------------------------------------------------------------
// Table of Contents page(s)
// Returns { tocPage, rowPositions } — rowPositions[i] describes where
// each submission's link rect lives on the TOC page so we can register
// its jump target after we know the destination page.
// -----------------------------------------------------------------
function drawTocSkeleton({ doc, font, fontBold, employee, period, submissions }) {
  const page = doc.addPage([A4.w, A4.h]);
  const { width, height } = page.getSize();

  // Header
  page.drawRectangle({ x: 0, y: height - 6, width, height: 6, color: BRAND });
  page.drawText('TABLE OF CONTENTS', { x: MARGIN, y: height - 70, size: 9, font: fontBold, color: MUTED });
  page.drawText(`${employee.name} · ${period}`, { x: MARGIN, y: height - 92, size: 14, font: fontBold, color: INK });

  page.drawLine({
    start: { x: MARGIN, y: height - 108 }, end: { x: width - MARGIN, y: height - 108 },
    thickness: 0.5, color: LINE,
  });

  // Column headers
  const headY = height - 128;
  page.drawText('#',         { x: MARGIN,        y: headY, size: 7, font: fontBold, color: MUTED });
  page.drawText('REFERENCE', { x: MARGIN + 25,   y: headY, size: 7, font: fontBold, color: MUTED });
  page.drawText('FORM',      { x: MARGIN + 155,  y: headY, size: 7, font: fontBold, color: MUTED });
  page.drawText('SUBMITTED', { x: MARGIN + 260,  y: headY, size: 7, font: fontBold, color: MUTED });
  page.drawText('AMOUNT',    { x: width - MARGIN - 130, y: headY, size: 7, font: fontBold, color: MUTED });
  page.drawText('OPEN',      { x: width - MARGIN - 30,  y: headY, size: 7, font: fontBold, color: MUTED });

  page.drawLine({
    start: { x: MARGIN, y: height - 138 }, end: { x: width - MARGIN, y: height - 138 },
    thickness: 0.5, color: LINE,
  });

  // Rows. rowPositions records the rect of each row's clickable area
  // (the whole row) so the caller can bind link annotations once the
  // target pages exist.
  let rowY = height - 158;
  const rowH = 22;
  const rowPositions = [];
  for (let i = 0; i < submissions.length; i++) {
    const s = submissions[i];
    const idx = (i + 1).toString().padStart(2, '0');
    const isSettledAdvance = s.status === 'settled' && s.form_type === 'met_advance';
    const isSettled        = s.status === 'settled';

    // What number goes in the AMOUNT column depends on the row type.
    //   Regular approved claim  → total_amount (full reimbursement)
    //   Settled advance         → differential_amount (signed; can be
    //                              negative when the employee spent
    //                              less than the advance)
    //   Legacy settled (non-adv) → actual_amount from actuals_json
    let amount, amountPrefix = 'INR ';
    if (isSettledAdvance) {
      amount = Number(s.differential_amount) || 0;
      // For negative differentials we render the sign to make it read
      // as "employee owes back" instead of "we owe less".
      if (amount < 0) {
        amountPrefix = '-INR ';
      } else if (amount > 0) {
        amountPrefix = '+INR ';
      }
    } else if (isSettled && s.actuals_json) {
      try { amount = parseFloat(JSON.parse(s.actuals_json).actual_amount) || 0; }
      catch (_) { amount = 0; }
    } else {
      amount = parseFloat(s.total_amount) || 0;
    }

    // Form label with a settled-advance tag appended so Arasu can see
    // at a glance which rows are "already paid, differential only" vs
    // "regular reimbursement".
    const baseLabel = FORM_LABEL[s.form_type] || s.form_type;
    const formLabel = isSettledAdvance
      ? `${baseLabel}  [advance settled]`
      : baseLabel;

    page.drawText(idx,               { x: MARGIN,       y: rowY, size: 9, font, color: MUTED });
    page.drawText(s.reference,       { x: MARGIN + 25,  y: rowY, size: 9, font: fontBold, color: INK });
    page.drawText(formLabel,         { x: MARGIN + 155, y: rowY, size: 9, font,
                                       color: isSettledAdvance ? MUTED : INK });
    page.drawText(fmtDate(s.submitted_at), {
                                       x: MARGIN + 260, y: rowY, size: 9, font, color: MUTED });

    // Late-settlement badge on the row (small ⚠️ marker in front of the
    // amount). Only shows on rows that were flagged late at file-time.
    if (s.late_settlement) {
      page.drawText('LATE', {
        x: width - MARGIN - 190, y: rowY,
        size: 7, font: fontBold, color: rgb(0.72, 0.16, 0.16),
      });
    }

    const amountColor = amount < 0 ? rgb(0.72, 0.16, 0.16) : INK;
    page.drawText(`${amountPrefix}${fmtInr(Math.abs(amount))}`, {
                                       x: width - MARGIN - 130, y: rowY, size: 9,
                                       font: fontBold, color: amountColor });
    // The "Open" affordance — styled like a link, real annotation added later
    page.drawText('>',                 { x: width - MARGIN - 26, y: rowY, size: 14, font: fontBold, color: BRAND });

    // Divider between rows
    page.drawLine({
      start: { x: MARGIN, y: rowY - 8 }, end: { x: width - MARGIN, y: rowY - 8 },
      thickness: 0.25, color: LINE,
    });

    // Whole row is clickable. Y-coord is baseline; we make the rect
    // extend a few pt above (ascender) and below (row divider).
    rowPositions.push({
      rect: [MARGIN, rowY - 8, width - MARGIN, rowY + 12],
      submission_id: s.id,
    });
    rowY -= rowH;

    if (rowY < 80) {
      // Overflow — for v1 we cap at ~30 rows per page. If someone has
      // more approved submissions than fit, we log a warning and drop
      // the extras from the TOC (they still appear in the merged
      // content). Realistically no employee submits >30 claims/month.
      // Turn 2 could split TOC across multiple pages if needed.
      console.warn(`[consolidated] TOC overflow for ${employee.name} ${period} — ${submissions.length - i - 1} rows omitted from TOC`);
      break;
    }
  }

  // Footer
  page.drawText(`${submissions.length} claim${submissions.length === 1 ? '' : 's'}`, {
    x: MARGIN, y: 30, size: 8, font, color: MUTED,
  });
  page.drawText(`Page 2 of report`, {
    x: width - MARGIN - 80, y: 30, size: 8, font, color: MUTED,
  });

  return { tocPage: page, rowPositions };
}

// -----------------------------------------------------------------
// The main entry point
// -----------------------------------------------------------------
/**
 * Build a consolidated PDF for one employee for one period.
 * @param {object} args
 * @param {object} args.employee   - {id, name, email, code, company}
 * @param {string} args.period     - 'YYYY-MM'
 * @param {Array}  args.submissions - approved submission rows from listApprovedForConsolidation
 *                                    Each must have .id, .reference, .form_type, .pdf_path,
 *                                    .total_amount, .status, .actuals_json, .submitted_at.
 *                                    We resolve attachments via the callback below (avoid
 *                                    coupling this file to db statements).
 * @param {Function} args.loadAttachments  async (submissionId) => Array<{stored_path, mime_type, filename}>
 * @param {string} args.outPath    - where to write the merged PDF
 * @returns {Promise<{ path: string, pageCount: number }>}
 */
async function buildConsolidatedReport({ employee, period, submissions, loadAttachments, outPath, signoffs }) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

  const generatedAt = new Date().toISOString();
  // Net payable to (or by) the employee for this month:
  //   - regular approved      → +total_amount
  //   - settled advance       → +differential_amount (signed, can be -ve)
  //   - settled non-advance   → +actual_amount from actuals_json
  // Kept in sync with the same computation in
  // consolidate-scheduler.generateForEmployeePeriod and the DB rollup
  // query, so all three views (PDF cover, DB row.total_amount, monthly-
  // summary approved_total) show the same number.
  const totalAmount = submissions.reduce((acc, s) => {
    if (s.status === 'settled' && s.form_type === 'met_advance') {
      return acc + (parseFloat(s.differential_amount) || 0);
    }
    if (s.status === 'settled' && s.actuals_json) {
      try { return acc + (parseFloat(JSON.parse(s.actuals_json).actual_amount) || 0); }
      catch (_) { return acc; }
    }
    return acc + (parseFloat(s.total_amount) || 0);
  }, 0);

  // 1) Cover
  const coverPage = doc.addPage([A4.w, A4.h]);
  drawCover({
    page: coverPage, font, fontBold,
    employee, period,
    total: totalAmount,
    submissionCount: submissions.length,
    generatedAt,
    signoffs,
  });

  // 2) TOC — draws the rows but leaves link annotations dangling; we bind
  // them below once we know each submission's first page.
  const { tocPage, rowPositions } = drawTocSkeleton({
    doc, font, fontBold, employee, period, submissions,
  });

  // 3) For each submission: append its individual report PDF pages + its
  // attachments' pages. Record the FIRST page of each block so we can:
  //    a) point the TOC row link at it
  //    b) add a "Home" link on every page in the block

  const submissionFirstPages = new Map();  // submissionId → PDFPage

  for (const s of submissions) {
    let submissionFirstPage = null;

    // A. The generated approval PDF for this submission
    if (s.pdf_path && fs.existsSync(s.pdf_path)) {
      try {
        const bytes = fs.readFileSync(s.pdf_path);
        const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
        const pages = await doc.copyPages(src, src.getPageIndices());
        for (const p of pages) {
          const added = doc.addPage(p);
          if (!submissionFirstPage) submissionFirstPage = added;
          drawHomeLink(added, tocPage, font);
        }
      } catch (e) {
        console.error(`[consolidated] failed to embed ${s.reference} report:`, e.message);
        const pg = doc.addPage([A4.w, A4.h]);
        pg.drawText(`Could not embed report for ${s.reference}`, {
          x: MARGIN, y: A4.h - 100, size: 12, font: fontBold, color: rgb(0.7, 0.1, 0.1),
        });
        if (!submissionFirstPage) submissionFirstPage = pg;
        drawHomeLink(pg, tocPage, font);
      }
    } else {
      const pg = doc.addPage([A4.w, A4.h]);
      pg.drawText(s.reference, { x: MARGIN, y: A4.h - 100, size: 20, font: fontBold, color: INK });
      pg.drawText(FORM_LABEL[s.form_type] || s.form_type, {
        x: MARGIN, y: A4.h - 128, size: 12, font, color: MUTED,
      });
      if (!submissionFirstPage) submissionFirstPage = pg;
      drawHomeLink(pg, tocPage, font);
    }

    // Turn 4 — Per-block banner for settled advances. A small colored
    // strip overlaid at the top of the first embedded page, telling
    // Arasu / Accounts that:
    //   - The advance was already paid (do NOT pay again from this block)
    //   - Only the differential is being reconciled this month
    // Positioned below any brand-strip at the very top of the source PDF
    // so it doesn't clobber the source's own header. Late-settlement rows
    // also get a small ⚠️ marker on this strip.
    if (submissionFirstPage && s.status === 'settled' && s.form_type === 'met_advance') {
      const { width: pw, height: ph } = submissionFirstPage.getSize();
      const bannerH = 42;
      const bannerY = ph - 60 - bannerH;  // ~60pt down from top edge

      const advanceAmt = parseFloat(s.total_amount) || 0;
      let actualAmt = 0;
      try { actualAmt = parseFloat(JSON.parse(s.actuals_json || '{}').actual_amount) || 0; }
      catch (_) {}
      const diff = parseFloat(s.differential_amount) || 0;

      // Background strip — light amber so it's clearly overlaid but
      // doesn't overpower the underlying content.
      submissionFirstPage.drawRectangle({
        x: 24, y: bannerY, width: pw - 48, height: bannerH,
        color: rgb(1.0, 0.976, 0.918),   // #fff7ea
        borderColor: rgb(0.85, 0.55, 0.05),
        borderWidth: 0.8,
        opacity: 0.94,
      });

      // Left side — the "already paid" callout
      submissionFirstPage.drawText('ADVANCE ALREADY PAID', {
        x: 34, y: bannerY + bannerH - 14, size: 8, font: fontBold, color: rgb(0.6, 0.35, 0.02),
      });
      submissionFirstPage.drawText(
        `Payment released${s.advance_paid_at ? ' on ' + fmtDate(s.advance_paid_at) : ''}${s.advance_paid_by ? ' by ' + s.advance_paid_by.split('@')[0] : ''}. This block is FYI — do not pay again from here.`,
        { x: 34, y: bannerY + 10, size: 8, font, color: rgb(0.4, 0.25, 0.02),
          maxWidth: (pw - 48) * 0.62 },
      );

      // Right side — the differential summary
      const rightX = 24 + (pw - 48) * 0.64;
      submissionFirstPage.drawText('THIS MONTH:', {
        x: rightX, y: bannerY + bannerH - 14, size: 7, font: fontBold, color: rgb(0.6, 0.35, 0.02),
      });
      const diffLabel = diff > 0 ? `Owe employee: +INR ${fmtInr(diff)}`
                      : diff < 0 ? `Employee owes back: INR ${fmtInr(Math.abs(diff))}`
                      : 'Balanced (advance = actual)';
      const diffColor = diff < 0 ? rgb(0.72, 0.16, 0.16)
                      : diff > 0 ? rgb(0.02, 0.5, 0.35)
                      : rgb(0.35, 0.35, 0.35);
      submissionFirstPage.drawText(diffLabel, {
        x: rightX, y: bannerY + bannerH - 26, size: 9, font: fontBold, color: diffColor,
      });
      submissionFirstPage.drawText(
        `advance INR ${fmtInr(advanceAmt)}  ·  actual INR ${fmtInr(actualAmt)}`,
        { x: rightX, y: bannerY + 10, size: 7, font, color: rgb(0.4, 0.25, 0.02) },
      );

      // Late-settlement badge appended to the top-right corner of the strip
      if (s.late_settlement) {
        const badgeX = pw - 24 - 68;
        const badgeY = bannerY + bannerH + 4;
        submissionFirstPage.drawRectangle({
          x: badgeX, y: badgeY, width: 68, height: 12,
          color: rgb(0.98, 0.90, 0.90),
          borderColor: rgb(0.72, 0.16, 0.16), borderWidth: 0.6,
        });
        const lateText = s.late_hours != null
          ? `LATE +${Math.round(s.late_hours)}h`
          : 'LATE SETTLEMENT';
        submissionFirstPage.drawText(lateText, {
          x: badgeX + 4, y: badgeY + 3, size: 7, font: fontBold,
          color: rgb(0.60, 0.10, 0.10),
        });
      }
    }


    // B. Attached bills for this submission
    let attachments = [];
    try { attachments = await loadAttachments(s.id) || []; }
    catch (e) { console.error(`[consolidated] loadAttachments failed for ${s.id}:`, e.message); }

    let billNo = 0;
    for (const att of attachments) {
      billNo++;
      const abs = resolveUpload(att.stored_path);
      if (!fs.existsSync(abs)) {
        console.warn(`[consolidated] missing attachment on disk: ${abs}`);
        continue;
      }
      const mime = (att.mime_type || '').toLowerCase();

      if (mime === 'application/pdf') {
        try {
          const src = await PDFDocument.load(fs.readFileSync(abs), { ignoreEncryption: true });
          const pages = await doc.copyPages(src, src.getPageIndices());
          for (const p of pages) {
            const added = doc.addPage(p);
            drawHomeLink(added, tocPage, font);
          }
        } catch (e) {
          const pg = doc.addPage([A4.w, A4.h]);
          pg.drawText(`Could not embed bill: ${att.filename}`, {
            x: MARGIN, y: A4.h - 100, size: 11, font, color: rgb(0.7, 0.1, 0.1),
          });
          drawHomeLink(pg, tocPage, font);
        }
      } else if (/^image\//.test(mime)) {
        const pg = doc.addPage([A4.w, A4.h]);
        pg.drawText(`${s.reference} · Bill ${billNo}`, {
          x: MARGIN, y: A4.h - 60, size: 9, font: fontBold, color: MUTED,
        });
        pg.drawText(att.filename, {
          x: MARGIN, y: A4.h - 80, size: 12, font: fontBold, color: INK,
        });
        pg.drawLine({
          start: { x: MARGIN, y: A4.h - 92 }, end: { x: A4.w - MARGIN, y: A4.h - 92 },
          thickness: 0.5, color: LINE,
        });
        try {
          const bytes = fs.readFileSync(abs);
          const img = mime === 'image/png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
          const availW = A4.w - 2 * MARGIN;
          const availH = A4.h - 130 - MARGIN;
          const scale = Math.min(availW / img.width, availH / img.height);
          const w = img.width * scale;
          const h = img.height * scale;
          pg.drawImage(img, {
            x: (A4.w - w) / 2,
            y: MARGIN + (availH - h) / 2,
            width: w, height: h,
          });
        } catch (e) {
          pg.drawText(`(image could not be rendered: ${e.message})`, {
            x: MARGIN, y: A4.h - 120, size: 10, font, color: rgb(0.7, 0.1, 0.1),
          });
        }
        drawHomeLink(pg, tocPage, font);
      }
    }

    if (submissionFirstPage) {
      submissionFirstPages.set(s.id, submissionFirstPage);
    }
  }

  // 4) Now bind TOC row links to their target pages
  for (const { rect, submission_id } of rowPositions) {
    const target = submissionFirstPages.get(submission_id);
    if (target) addInternalLink(tocPage, target, rect);
  }

  // 5) Save
  const bytes = await doc.save();
  fs.writeFileSync(outPath, bytes);
  return { path: outPath, pageCount: doc.getPageCount() };
}

module.exports = { buildConsolidatedReport };
