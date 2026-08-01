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
function drawCover({ page, font, fontBold, employee, period, total, submissionCount, generatedAt }) {
  const { width, height } = page.getSize();

  // Brand strip at top
  page.drawRectangle({ x: 0, y: height - 6, width, height: 6, color: BRAND });

  // Category label
  page.drawText('CONSOLIDATED REPORT', {
    x: MARGIN, y: height - 90,
    size: 9, font: fontBold, color: MUTED,
    // pdf-lib doesn't support characterSpacing natively; the label reads
    // fine at this size without it.
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

  // Total block on the right
  const totalLabel = 'TOTAL AMOUNT';
  const totalStr = `INR ${fmtInr(total)}`;
  const totalX = width - MARGIN - 240;
  page.drawText(totalLabel, { x: totalX, y: height - 205, size: 8, font: fontBold, color: MUTED });
  page.drawText(totalStr, { x: totalX, y: height - 235, size: 22, font: fontBold, color: INK });
  page.drawText(`${submissionCount} claim${submissionCount === 1 ? '' : 's'}`, {
    x: totalX, y: height - 253, size: 9, font, color: MUTED,
  });

  page.drawLine({
    start: { x: MARGIN, y: height - 280 }, end: { x: width - MARGIN, y: height - 280 },
    thickness: 0.5, color: LINE,
  });

  // Status band (Turn 2 will overlay approvals here)
  page.drawText('STATUS', { x: MARGIN, y: height - 310, size: 8, font: fontBold, color: MUTED });
  page.drawText('DRAFT — AWAITING REVIEW', { x: MARGIN, y: height - 328, size: 12, font: fontBold, color: rgb(0.7, 0.4, 0.05) });

  // Footer
  page.drawText(`Generated ${fmtDate(generatedAt)}`, {
    x: MARGIN, y: 40, size: 8, font, color: MUTED,
  });
  page.drawText('METFRAA · EXPENSE PORTAL · CONSOLIDATED', {
    x: MARGIN, y: 28, size: 7, font: fontBold, color: MUTED,
  });
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
    const amount = s.status === 'settled' && s.actuals_json
      ? (() => { try { return parseFloat(JSON.parse(s.actuals_json).actual_amount) || 0; } catch (_) { return 0; } })()
      : (parseFloat(s.total_amount) || 0);

    page.drawText(idx,               { x: MARGIN,       y: rowY, size: 9, font, color: MUTED });
    page.drawText(s.reference,       { x: MARGIN + 25,  y: rowY, size: 9, font: fontBold, color: INK });
    page.drawText(FORM_LABEL[s.form_type] || s.form_type, {
                                       x: MARGIN + 155, y: rowY, size: 9, font, color: INK });
    page.drawText(fmtDate(s.submitted_at), {
                                       x: MARGIN + 260, y: rowY, size: 9, font, color: MUTED });
    page.drawText(`INR ${fmtInr(amount)}`, {
                                       x: width - MARGIN - 130, y: rowY, size: 9, font: fontBold, color: INK });
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
async function buildConsolidatedReport({ employee, period, submissions, loadAttachments, outPath }) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

  const generatedAt = new Date().toISOString();
  const totalAmount = submissions.reduce((acc, s) => {
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
        // Fall through and add a placeholder page so the TOC link at
        // least lands somewhere reasonable
        const pg = doc.addPage([A4.w, A4.h]);
        pg.drawText(`Could not embed report for ${s.reference}`, {
          x: MARGIN, y: A4.h - 100, size: 12, font: fontBold, color: rgb(0.7, 0.1, 0.1),
        });
        if (!submissionFirstPage) submissionFirstPage = pg;
        drawHomeLink(pg, tocPage, font);
      }
    } else {
      // No individual report PDF on disk (shouldn't happen for approved
      // submissions, but be defensive) — add a title page so the TOC
      // link points somewhere.
      const pg = doc.addPage([A4.w, A4.h]);
      pg.drawText(s.reference, { x: MARGIN, y: A4.h - 100, size: 20, font: fontBold, color: INK });
      pg.drawText(FORM_LABEL[s.form_type] || s.form_type, {
        x: MARGIN, y: A4.h - 128, size: 12, font, color: MUTED,
      });
      if (!submissionFirstPage) submissionFirstPage = pg;
      drawHomeLink(pg, tocPage, font);
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
