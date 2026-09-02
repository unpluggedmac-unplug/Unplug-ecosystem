const PDFDocument = require('pdfkit');

// A single shared layout for both documents an admin can generate from the
// unified payment queue — an invoice (payment still owed) and a receipt
// (payment already received). Same table/breakdown either way; only the
// title and the one sentence under it change, so this isn't two near-
// identical templates to keep in step.
//
// VAT: Unplug's prices are VAT-INCLUSIVE, so where a VAT registration number is
// configured this shows the VAT already contained in the total — not 15% added
// on top. A South African tax invoice must carry the vendor's registration
// number, so the document only calls itself a TAX INVOICE when it has one.
//
// With no number configured it renders exactly as before: a plain INVOICE with
// no VAT line. That is the safe direction to fail — a tax invoice missing its
// registration number is worse than an invoice that does not claim to be one,
// and this file will not invent a number it was not given.
//
// The arithmetic lives in utils/invoices.js (vatBreakdown); this only prints
// what it is handed, so a list row and a PDF cannot disagree.
function generateDocument({
  kind, reference, customerName, customerEmail,
  items, subtotal, voucherDiscount, creditUsed, total,
  method, status, date,
  // Optional. Present for a member-facing invoice; absent for the admin
  // queue's documents, which keep their existing look.
  invoiceNumber, vatNumber, vatRate, vatAmount, netAmount,
}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Only a registered vendor may issue a "tax invoice", so the word is earned
    // by having a registration number rather than assumed.
    const isTax = Boolean(vatNumber) && Number(vatAmount) > 0;
    const title = kind === 'receipt'
      ? (isTax ? 'TAX RECEIPT' : 'RECEIPT')
      : (isTax ? 'TAX INVOICE' : 'INVOICE');
    const intro = kind === 'receipt'
      ? 'This confirms payment has been received for the following.'
      : 'This is a request for payment for the following.';

    doc.fontSize(20).font('Helvetica-Bold').fillColor('#d20709').text('Unplug Magazine');
    doc.fontSize(10).font('Helvetica').fillColor('#454545').text('accounts@unplugnews.com');
    if (vatNumber) doc.text(`VAT Reg No: ${vatNumber}`);
    doc.moveDown(1.5);

    doc.fontSize(16).font('Helvetica-Bold').fillColor('#0f0e0e').text(title);
    doc.fontSize(10).font('Helvetica').fillColor('#454545').text(intro);
    doc.moveDown(1);

    doc.fontSize(10).fillColor('#0f0e0e');
    if (invoiceNumber) doc.text(`Invoice number: ${invoiceNumber}`);
    doc.text(`Reference: ${reference}`);
    doc.text(`Date: ${date}`);
    if (customerName) doc.text(`Customer: ${customerName}`);
    if (customerEmail) doc.text(`Email: ${customerEmail}`);
    doc.text(`Payment method: ${String(method || '').toUpperCase()}`);
    doc.text(`Status: ${status}`);
    doc.moveDown(1);

    const tableTop = doc.y;
    doc.font('Helvetica-Bold');
    doc.text('Description', 50, tableTop);
    doc.text('Amount', 450, tableTop, { width: 95, align: 'right' });
    doc.moveTo(50, tableTop + 15).lineTo(545, tableTop + 15).strokeColor('#dddddd').stroke();

    doc.font('Helvetica');
    let y = tableTop + 22;
    (items && items.length ? items : [{ label: 'Payment', amount: subtotal }]).forEach((item) => {
      doc.text(item.label, 50, y, { width: 380 });
      doc.text(`R${Number(item.amount).toFixed(2)}`, 450, y, { width: 95, align: 'right' });
      y += 18;
    });
    doc.moveTo(50, y + 2).lineTo(545, y + 2).strokeColor('#dddddd').stroke();
    y += 12;

    const row = (label, value, bold) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica');
      doc.text(label, 340, y, { width: 110, align: 'left' });
      doc.text(value, 450, y, { width: 95, align: 'right' });
      y += 16;
    };
    row('Subtotal', `R${Number(subtotal).toFixed(2)}`);
    if (Number(voucherDiscount) > 0) row('Voucher', `-R${Number(voucherDiscount).toFixed(2)}`);
    if (Number(creditUsed) > 0) row('Account credit', `-R${Number(creditUsed).toFixed(2)}`);
    // The VAT already inside the total, shown between the discounts and the
    // total so it reads as part OF the amount rather than as an addition to it.
    if (isTax) {
      row('Excl. VAT', `R${Number(netAmount).toFixed(2)}`);
      row(`VAT @ ${Number(vatRate).toFixed(0)}%`, `R${Number(vatAmount).toFixed(2)}`);
    }
    row(isTax ? 'Total incl. VAT' : 'Total', `R${Number(total).toFixed(2)}`, true);

    doc.y = y + 30;
    doc.fontSize(9).font('Helvetica').fillColor('#79726a')
      .text('Unplug Magazine — this document was generated automatically and does not require a signature.', 50, doc.y, { width: 495 });

    doc.end();
  });
}

module.exports = { generateDocument };
