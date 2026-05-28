// ====================================================================
//  PDF MERGE · combine the generated report with uploaded bills
// ====================================================================
//  Produces ONE final PDF:  [ report pages ] + [ each bill ]
//   - Uploaded PDFs: their pages are appended directly.
//   - Uploaded images (jpg/png): each placed on its own A4 page,
//     scaled to fit, with a caption header.
//
//  Used on APPROVAL to build the archival report stored in OneDrive
//  under <Employee>/Reports/.
// ====================================================================

const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const A4 = { w: 595.28, h: 841.89 };
const MARGIN = 40;

function resolveUpload(storedPath) {
  return path.isAbsolute(storedPath) ? storedPath : path.join(__dirname, '..', '..', storedPath);
}

/**
 * @param {string} reportPdfPath  the PDFKit-generated report on disk
 * @param {Array}  attachments    [{ stored_path, filename, mime_type, label }]
 * @param {string} outPath        where to write the merged PDF
 * @returns {Promise<string>}     outPath
 */
async function mergeReportWithBills(reportPdfPath, attachments, outPath) {
  const merged = await PDFDocument.create();
  const helv = await merged.embedFont(StandardFonts.Helvetica);
  const helvBold = await merged.embedFont(StandardFonts.HelveticaBold);

  // 1) Report pages first
  if (reportPdfPath && fs.existsSync(reportPdfPath)) {
    const reportBytes = fs.readFileSync(reportPdfPath);
    const reportDoc = await PDFDocument.load(reportBytes);
    const pages = await merged.copyPages(reportDoc, reportDoc.getPageIndices());
    pages.forEach(p => merged.addPage(p));
  }

  // 2) Each bill
  let billNo = 0;
  const total = attachments.length;
  for (const att of attachments) {
    billNo++;
    const abs = resolveUpload(att.stored_path);
    if (!fs.existsSync(abs)) continue;
    const mime = (att.mime_type || '').toLowerCase();

    if (mime === 'application/pdf') {
      // Append the PDF's pages, prefixed by a caption page
      addCaptionPage(merged, helv, helvBold, att, billNo, total);
      try {
        const src = await PDFDocument.load(fs.readFileSync(abs), { ignoreEncryption: true });
        const pages = await merged.copyPages(src, src.getPageIndices());
        pages.forEach(p => merged.addPage(p));
      } catch (e) {
        // If a PDF can't be parsed, note it on a page rather than failing the whole merge
        const pg = merged.addPage([A4.w, A4.h]);
        pg.drawText(`Could not embed PDF: ${att.filename}`, { x: MARGIN, y: A4.h - 80, size: 11, font: helv, color: rgb(0.7, 0.1, 0.1) });
      }
    } else if (/^image\//.test(mime)) {
      await addImagePage(merged, helv, helvBold, abs, mime, att, billNo, total);
    }
  }

  const bytes = await merged.save();
  fs.writeFileSync(outPath, bytes);
  return outPath;
}

function addCaptionPage(doc, helv, helvBold, att, billNo, total) {
  const pg = doc.addPage([A4.w, A4.h]);
  pg.drawText(`BILL ${billNo} OF ${total}`, { x: MARGIN, y: A4.h - 70, size: 10, font: helvBold, color: rgb(0.42, 0.46, 0.54) });
  pg.drawText(att.label || att.filename, { x: MARGIN, y: A4.h - 95, size: 15, font: helvBold, color: rgb(0.05, 0.08, 0.13) });
  pg.drawText(`${att.mime_type}`, { x: MARGIN, y: A4.h - 115, size: 9, font: helv, color: rgb(0.42, 0.46, 0.54) });
  pg.drawLine({ start: { x: MARGIN, y: A4.h - 125 }, end: { x: A4.w - MARGIN, y: A4.h - 125 }, thickness: 0.5, color: rgb(0.84, 0.87, 0.9) });
  pg.drawText('(original PDF pages follow)', { x: MARGIN, y: A4.h - 145, size: 9, font: helv, color: rgb(0.42, 0.46, 0.54) });
}

async function addImagePage(doc, helv, helvBold, abs, mime, att, billNo, total) {
  const pg = doc.addPage([A4.w, A4.h]);
  // caption
  pg.drawText(`BILL ${billNo} OF ${total}`, { x: MARGIN, y: A4.h - 60, size: 10, font: helvBold, color: rgb(0.42, 0.46, 0.54) });
  pg.drawText(att.label || att.filename, { x: MARGIN, y: A4.h - 82, size: 14, font: helvBold, color: rgb(0.05, 0.08, 0.13) });
  pg.drawLine({ start: { x: MARGIN, y: A4.h - 92 }, end: { x: A4.w - MARGIN, y: A4.h - 92 }, thickness: 0.5, color: rgb(0.84, 0.87, 0.9) });

  const bytes = fs.readFileSync(abs);
  let img;
  try {
    img = /png/.test(mime) ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  } catch (e) {
    pg.drawText(`Could not embed image: ${att.filename}`, { x: MARGIN, y: A4.h - 120, size: 11, font: helv, color: rgb(0.7, 0.1, 0.1) });
    return;
  }
  const maxW = A4.w - MARGIN * 2;
  const maxH = A4.h - 130 - MARGIN;
  const scale = Math.min(maxW / img.width, maxH / img.height, 1);
  const w = img.width * scale, h = img.height * scale;
  pg.drawImage(img, { x: (A4.w - w) / 2, y: (A4.h - 110 - h), width: w, height: h });
}

module.exports = { mergeReportWithBills };
