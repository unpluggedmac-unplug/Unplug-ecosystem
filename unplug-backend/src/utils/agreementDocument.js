const PDFDocument = require('pdfkit');
const pool = require('../db');
const { vatSettings } = require('./invoices');
const { fetchPrivateObject } = require('../routes/uploads');

const MARGIN = 50;
const PAGE_WIDTH = 595.28;
const CONTENT_WIDTH = PAGE_WIDTH - (MARGIN * 2);

function text(v) { return v === null || v === undefined ? '' : String(v); }
function plainHtml(v) {
  return text(v)
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n\n')
    .replace(/<\/li\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function businessSettings(client = pool) {
  const r = await client.query(
    `SELECT key, value FROM settings
      WHERE key IN ('unplug_business_name', 'unplug_business_registration_number',
                    'unplug_business_address', 'unplug_business_contact_email')`
  );
  const map = Object.fromEntries(r.rows.map((row) => [row.key, row.value]));
  const vat = await vatSettings(client);
  return {
    name: String(map.unplug_business_name || 'Unplug Magazine').trim() || 'Unplug Magazine',
    registrationNumber: String(map.unplug_business_registration_number || '').trim(),
    address: String(map.unplug_business_address || '').trim(),
    email: String(map.unplug_business_contact_email || 'info@unplugnews.com').trim(),
    vatNumber: vat.vatNumber || '',
  };
}

async function imageBuffer(url) {
  if (!url) return null;
  try {
    let response;
    if (String(url).includes('.r2.cloudflarestorage.com/')) response = await fetchPrivateObject(url);
    else response = await fetch(url);
    if (!response || !response.ok) return null;
    return Buffer.from(await response.arrayBuffer());
  } catch (err) {
    console.warn('[agreement document] could not load image:', err.message);
    return null;
  }
}

function addDivider(doc) {
  doc.moveDown(0.5);
  const y = doc.y;
  doc.moveTo(MARGIN, y).lineTo(PAGE_WIDTH - MARGIN, y).strokeColor('#dddddd').stroke();
  doc.moveDown(0.8);
}
function ensureSpace(doc, required = 80) { if (doc.y + required > doc.page.height - 70) doc.addPage(); }
function heading(doc, value) {
  ensureSpace(doc, 55);
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#0f0e0e').text(value, MARGIN, doc.y, { width: CONTENT_WIDTH });
  doc.moveDown(0.45);
}
function body(doc, value) {
  if (!value) return;
  doc.font('Helvetica').fontSize(9.5).fillColor('#272626').text(text(value), MARGIN, doc.y, { width: CONTENT_WIDTH, lineGap: 2 });
  doc.moveDown(0.75);
}
function answerLabel(field) { return field.label || field.field_key || field.key || 'Answer'; }
function answerKey(field) { return field.field_key || field.key; }
function formatAnswer(value) {
  if (value === true) return 'Yes';
  if (value === false) return 'No';
  if (Array.isArray(value)) return value.join(', ');
  if (value && typeof value === 'object') return JSON.stringify(value);
  return text(value) || '—';
}

async function generateAgreementDocument({ submission, fields = [], clauses = [], preview = false, client = pool }) {
  const business = await businessSettings(client);
  const signatureImage = await imageBuffer(submission.signature_url);
  const guardianSignatureImage = await imageBuffer(submission.guardian_signature_url);
  const companyStampImage = await imageBuffer(submission.company_stamp_url);

  let recordedSignatures = [];
  let supportingItems = [];
  if (!preview && submission.id) {
    try {
      const sig = await client.query(
        `SELECT s.*,p.legal_name,p.email,p.mobile,p.capacity,p.role,p.party_type
           FROM agreement_signatures s
           LEFT JOIN agreement_submission_parties p ON p.id=s.party_id
          WHERE s.submission_id=$1 ORDER BY s.signed_at,s.id`, [submission.id]
      );
      recordedSignatures = sig.rows;
      for (const row of recordedSignatures) row._image = await imageBuffer(row.signature_url);
      const items = await client.query(
        `SELECT si.note_text,si.upload_url,fi.label,fi.kind,fi.visibility
           FROM agreement_submission_items si
           LEFT JOIN agreement_form_items fi ON fi.id=si.form_item_id
          WHERE si.submission_id=$1 ORDER BY si.id`, [submission.id]
      );
      supportingItems = items.rows;
    } catch (err) {
      console.warn('[agreement document] generator detail lookup failed:', err.message);
    }
  }

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4', margin: MARGIN, bufferPages: true,
      info: {
        Title: text(submission.title_at_signing || submission.title || 'Agreement'),
        Author: business.name,
        Subject: preview ? 'Agreement preview' : `Agreement ${submission.reference || ''}`,
      },
    });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    if (preview) {
      doc.save();doc.rect(0, 0, doc.page.width, 30).fill('#0f0e0e');
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(10).text('PREVIEW — NOT A SIGNED AGREEMENT', MARGIN, 10, { width: CONTENT_WIDTH, align: 'center' });
      doc.restore();doc.y = 45;
    }

    doc.font('Helvetica-Bold').fontSize(20).fillColor('#d20709').text(business.name, MARGIN, doc.y, { width: CONTENT_WIDTH });
    doc.font('Helvetica').fontSize(8.5).fillColor('#454545');
    if (business.registrationNumber) doc.text(`Registration: ${business.registrationNumber}`);
    if (business.vatNumber) doc.text(`VAT Reg No: ${business.vatNumber}`);
    if (business.address) doc.text(business.address);
    if (business.email) doc.text(business.email);
    addDivider(doc);

    doc.font('Helvetica-Bold').fontSize(17).fillColor('#0f0e0e').text(text(submission.title_at_signing || submission.title || 'Agreement'), MARGIN, doc.y, { width: CONTENT_WIDTH });
    doc.moveDown(0.4);doc.font('Helvetica').fontSize(9).fillColor('#454545');
    if (submission.reference) doc.text(`Reference: ${submission.reference}`);
    const version = Number(submission.agreement_version || submission.version || 1);
    doc.text(`Template version: v${Number.isFinite(version) ? version : 1}`);
    const date = submission.submitted_at || submission.date || new Date();
    doc.text(`Document date: ${new Date(date).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg' })}`);
    if (submission.workflow_status) doc.text(`Workflow status: ${String(submission.workflow_status).replaceAll('_',' ')}`);

    const description = submission.description_at_signing || submission.description;
    if (description) { addDivider(doc);heading(doc, 'Purpose / Background');body(doc, description); }

    const serviceName = submission.service_name_at_signing || submission.service_name;
    const serviceDescription = submission.service_description_at_signing || submission.service_description;
    const serviceReference = submission.service_reference_at_signing || submission.service_reference;
    const clientName = submission.client_name_at_signing || submission.client_name;
    if (serviceName || serviceDescription || serviceReference || clientName) {
      addDivider(doc);heading(doc, 'Service / Engagement');doc.font('Helvetica').fontSize(9.5).fillColor('#272626');
      if (serviceName) doc.text(`Service: ${serviceName}`);if (clientName) doc.text(`Client / party: ${clientName}`);if (serviceReference) doc.text(`Service reference: ${serviceReference}`);if (serviceDescription) doc.text(`Description: ${serviceDescription}`);doc.moveDown(0.6);
    }

    const amount = submission.amount_at_signing !== undefined ? submission.amount_at_signing : submission.amount;
    if (amount !== null && amount !== undefined && Number(amount) > 0) { heading(doc, 'Commercial Terms');body(doc, `Agreement amount: R${Number(amount).toFixed(2)}. Payment arrangement: ${text(submission.payment_mode_at_signing || submission.payment_mode || 'none').replaceAll('_', ' ')}.`); }

    const rules = submission.rules_at_signing !== undefined ? submission.rules_at_signing : submission.rules;
    if (rules) { addDivider(doc);heading(doc, 'Rules / Requirements');body(doc, plainHtml(rules)); }
    const terms = submission.terms_at_signing !== undefined ? submission.terms_at_signing : submission.terms;
    if (terms) { addDivider(doc);heading(doc, 'Terms & Conditions');body(doc, plainHtml(terms)); }
    if (clauses.length) {
      addDivider(doc);heading(doc, 'Agreement Clauses');
      for (const clause of clauses) {
        ensureSpace(doc,70);if (clause.title) doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#0f0e0e').text(text(clause.title),MARGIN,doc.y,{width:CONTENT_WIDTH});
        body(doc, plainHtml(clause.bodyHtml || clause.body_html || clause.block_body_html));
      }
    }

    addDivider(doc);heading(doc, 'Information Supplied');
    const answers = submission.answers && typeof submission.answers === 'object' ? submission.answers : {};
    const visibleFields = fields.filter((field) => answerKey(field) && Object.prototype.hasOwnProperty.call(answers, answerKey(field)));
    if (!visibleFields.length) body(doc, 'No additional information fields were supplied.');
    else for (const field of visibleFields) { ensureSpace(doc,38);doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#454545').text(answerLabel(field),MARGIN,doc.y,{width:CONTENT_WIDTH});doc.font('Helvetica').fontSize(9.5).fillColor('#0f0e0e').text(formatAnswer(answers[answerKey(field)]),MARGIN,doc.y+2,{width:CONTENT_WIDTH});doc.moveDown(0.65); }

    if (supportingItems.length) {
      addDivider(doc);heading(doc, 'Supporting Notes / Uploads');
      for (const item of supportingItems) {
        ensureSpace(doc,45);doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#454545').text(item.label || (item.kind==='upload'?'Uploaded file':'Note'),MARGIN,doc.y,{width:CONTENT_WIDTH});
        if (item.note_text) body(doc,item.note_text);else if (item.upload_url) body(doc,'Supporting file uploaded and retained in secure Unplug storage.');
      }
    }

    if (recordedSignatures.length) {
      addDivider(doc);heading(doc, 'Declarations & Signatures');
      for (const sig of recordedSignatures) {
        ensureSpace(doc,110);const side=sig.party_side==='party_a'?'Party A':'Party B';const role=text(sig.role||'signer').replaceAll('_',' ');
        doc.font('Helvetica-Bold').fontSize(10).fillColor('#0f0e0e').text(`${side} — ${sig.legal_name || 'Signer'}`,MARGIN,doc.y,{width:CONTENT_WIDTH});
        doc.font('Helvetica').fontSize(8.7).fillColor('#454545');doc.text(`Role: ${role}${sig.capacity?` · Capacity: ${sig.capacity}`:''}`);doc.text(`Signature method: ${text(sig.signature_type).replaceAll('_',' ')}`);doc.text(`Signed: ${new Date(sig.signed_at).toLocaleString('en-ZA',{timeZone:'Africa/Johannesburg'})}`);
        if (sig.signature_text) doc.text(`Typed signature: ${sig.signature_text}`);
        if (sig._image) { try { doc.moveDown(0.3);doc.image(sig._image,MARGIN,doc.y,{fit:[220,65]});doc.moveDown(4.8); } catch (_) {} }
        doc.moveDown(0.6);
      }
    } else {
      if (submission.guardian_name) {
        addDivider(doc);heading(doc, 'Parent / Guardian');body(doc, `Name: ${submission.guardian_name}${submission.guardian_email ? `\nEmail: ${submission.guardian_email}` : ''}`);if (submission.guardian_signature_text) body(doc, `Signature: ${submission.guardian_signature_text}`);if (guardianSignatureImage) { ensureSpace(doc,90);try { doc.image(guardianSignatureImage,MARGIN,doc.y,{fit:[220,70]});doc.moveDown(5); } catch (_) {} }
      }
      addDivider(doc);heading(doc, 'Signature');body(doc, `Signed by: ${submission.signer_name || (preview ? 'Preview Signer' : '')}`);if (submission.business_signatory_capacity) body(doc, `Capacity: ${submission.business_signatory_capacity}`);if (submission.signature_text) body(doc, `Signature: ${submission.signature_text}`);if (signatureImage) { ensureSpace(doc,100);try { doc.image(signatureImage,MARGIN,doc.y,{fit:[250,80]});doc.moveDown(5.5); } catch (_) {} }
    }

    if (!preview) { ensureSpace(doc,80);const stampX=PAGE_WIDTH-MARGIN-62,stampY=Math.max(80,doc.y-35);doc.save();doc.circle(stampX+31,stampY+31,29).lineWidth(2).strokeColor('#d20709').stroke();doc.font('Helvetica-Bold').fontSize(7).fillColor('#d20709').text('SUBMITTED',stampX+3,stampY+26,{width:56,align:'center'});doc.restore(); }

    if (!recordedSignatures.length && (submission.witness_name || submission.witness_signature)) { addDivider(doc);heading(doc, 'Witness');body(doc, `Witness name: ${submission.witness_name || '—'}\nWitness signature: ${submission.witness_signature || '—'}`); }
    if ((submission.require_company_stamp_at_signing || submission.require_company_stamp) && companyStampImage) { addDivider(doc);heading(doc, 'Company Stamp');ensureSpace(doc,130);try { doc.image(companyStampImage,MARGIN,doc.y,{fit:[180,110]});doc.moveDown(7); } catch (_) {} }

    const post = submission.post_signing_requirements_at_signing !== undefined ? submission.post_signing_requirements_at_signing : submission.post_signing_requirements;
    if (post) {
      ensureSpace(doc,120);doc.moveDown(0.7);const top=doc.y;const cleanPost=plainHtml(post);const boxText=`POST-SIGNING REQUIREMENTS\n${cleanPost}\n\nSend required supporting items to info@unplugnews.com and quote the agreement reference.`;const h=doc.heightOfString(boxText,{width:CONTENT_WIDTH-28,lineGap:2})+24;doc.save();doc.rect(MARGIN,top,CONTENT_WIDTH,h).fill('#f1f0ef').strokeColor('#0f0e0e').stroke();doc.fillColor('#0f0e0e').font('Helvetica-Bold').fontSize(9).text('POST-SIGNING REQUIREMENTS',MARGIN+14,top+12,{width:CONTENT_WIDTH-28});doc.font('Helvetica').fontSize(9).text(`${cleanPost}\n\nSend required supporting items to info@unplugnews.com and quote the agreement reference.`,MARGIN+14,top+30,{width:CONTENT_WIDTH-28,lineGap:2});doc.restore();doc.y=top+h+10;
    }

    const range = doc.bufferedPageRange();
    for (let i=range.start;i<range.start+range.count;i+=1) { doc.switchToPage(i);doc.font('Helvetica').fontSize(7.5).fillColor('#79726a').text(`${preview?'PREVIEW — ':''}${submission.reference?`REF ${submission.reference} — `:''}v${Number.isFinite(version)?version:1} — Page ${i-range.start+1} of ${range.count}`,MARGIN,doc.page.height-38,{width:CONTENT_WIDTH,align:'center',lineBreak:false}); }
    doc.end();
  });
}

module.exports = { generateAgreementDocument, businessSettings, imageBuffer, plainHtml };
