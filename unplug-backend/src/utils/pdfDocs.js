const PDFDocument = require('pdfkit');

// A single shared layout for both documents an admin can generate from the
// unified payment queue — an invoice (payment still owed) and a receipt
// (payment already received). Same table/breakdown either way; only the
// title and the one sentence under it change, so this isn't two near-
// identical templates to keep in step.
//
// No VAT line: nothing else in this codebase calculates or charges VAT
// (checked — the only "VAT" match anywhere in the backend is the substring
// inside "OZOW_PRIVATE_KEY"), so inventing one here would show a number
// nobody actually charged.
function generateDocument({
  kind, reference, customerName, customerEmail,
  items, subtotal, voucherDiscount, creditUsed, total,
  method, status, date,
}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const title = kind === 'receipt' ? 'RECEIPT' : 'INVOICE';
    const intro = kind === 'receipt'
      ? 'This confirms payment has been received for the following.'
      : 'This is a request for payment for the following.';

    doc.fontSize(20).font('Helvetica-Bold').fillColor('#d20709').text('Unplug Magazine');
    doc.fontSize(10).font('Helvetica').fillColor('#454545').text('accounts@unplugnews.com');
    doc.moveDown(1.5);

    doc.fontSize(16).font('Helvetica-Bold').fillColor('#0f0e0e').text(title);
    doc.fontSize(10).font('Helvetica').fillColor('#454545').text(intro);
    doc.moveDown(1);

    doc.fontSize(10).fillColor('#0f0e0e');
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
    row('Total', `R${Number(total).toFixed(2)}`, true);

    doc.y = y + 30;
    doc.fontSize(9).font('Helvetica').fillColor('#79726a')
      .text('Unplug Magazine — this document was generated automatically and does not require a signature.', 50, doc.y, { width: 495 });

    doc.end();
  });
}

module.exports = { generateDocument };
