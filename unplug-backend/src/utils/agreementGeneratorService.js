const pool = require('../db');
const { sendEmail } = require('./email');
const { generateAgreementDocument } = require('./agreementDocument');
const G = require('./agreementGenerator');

function asObject(v) { return G.safeJson(v, {}); }
function asArray(v) { return G.safeJson(v, []); }

function cleanRichText(value, max = 100000) {
  const raw = G.trim(value, max) || '';
  return raw
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript\s*:/gi, '');
}

async function loadSubmission(id, client = pool) {
  const n = Number(id);
  if (!Number.isInteger(n)) return null;
  const r = await client.query('SELECT * FROM agreement_submissions WHERE id=$1', [n]);
  return r.rows[0] || null;
}

async function resolveSignerAccess(token, client = pool) {
  if (!token || String(token).length < 20) return null;
  const direct = await client.query('SELECT * FROM agreement_submissions WHERE signing_token=$1', [String(token)]);
  if (direct.rowCount) return { submission:direct.rows[0], party:null, accessKind:'agreement' };
  const party = await client.query(`SELECT p.*,s.agreement_id,s.user_id AS submission_user_id,s.reference,s.signing_token AS agreement_signing_token,
      s.workflow_status,s.locked_at,s.access_method,s.party_a_signed_at,s.party_b_signed_at
      FROM agreement_submission_parties p JOIN agreement_submissions s ON s.id=p.submission_id
      WHERE p.signing_token=$1 AND p.party_side='party_b'`, [String(token)]);
  if (!party.rowCount) return null;
  const submission = await loadSubmission(party.rows[0].submission_id, client);
  return { submission, party:party.rows[0], accessKind:'party' };
}

function assertSignerAccess(access, req, { allowLocked = false } = {}) {
  if (!access || !access.submission) {
    const err = new Error('This private agreement link is not valid.'); err.statusCode = 404; throw err;
  }
  const { submission, party } = access;
  const method = submission.access_method || 'private_link';
  if (method === 'member_login') {
    if (!req.user) {
      const err = new Error('Sign in to your Unplug account to continue this agreement.'); err.statusCode = 401; throw err;
    }
    const requiredUser = party && party.member_user_id ? party.member_user_id : submission.user_id;
    if (requiredUser && Number(requiredUser) !== Number(req.user.id)) {
      const err = new Error('This agreement is assigned to another member account.'); err.statusCode = 403; throw err;
    }
  }
  if (!allowLocked && submission.locked_at) {
    const err = new Error('This submitted agreement is locked. An administrator must reopen it before it can be changed.'); err.statusCode = 423; throw err;
  }
  if (party && party.signed_at) {
    const err = new Error('This signer has already signed the agreement.'); err.statusCode = 409; throw err;
  }
}

async function hasAnySignature(submissionId, client = pool) {
  const r = await client.query('SELECT 1 FROM agreement_signatures WHERE submission_id=$1 LIMIT 1', [submissionId]);
  return r.rowCount > 0;
}

async function requireInstanceAccess(req, res, next) {
  try {
    const submission = await loadSubmission(req.params.id);
    if (!submission) return res.status(404).json({ error: 'Agreement record not found.' });
    if (!(await G.canStaffAccessSubmission(req, submission.id))) {
      return res.status(403).json({ error: 'This agreement is not assigned to you.' });
    }
    req.agreementSubmission = submission;
    return next();
  } catch (err) { return next(err); }
}

async function ensureFormShortCode(formId, client = pool) {
  const current = await client.query('SELECT short_code FROM agreement_forms WHERE id=$1', [formId]);
  if (!current.rowCount) return null;
  if (current.rows[0].short_code) return current.rows[0].short_code;
  for (;;) {
    const code = G.randomToken(6).slice(0, 10).toUpperCase();
    try {
      await client.query('UPDATE agreement_forms SET short_code=$2 WHERE id=$1 AND short_code IS NULL', [formId, code]);
      const check = await client.query('SELECT short_code FROM agreement_forms WHERE id=$1', [formId]);
      return check.rows[0].short_code;
    } catch (err) {
      if (err.code !== '23505') throw err;
    }
  }
}

async function snapshotForSubmission(submission, client = pool) {
  if (submission.template_version_id) {
    const version = await client.query('SELECT snapshot FROM agreement_form_versions WHERE id=$1', [submission.template_version_id]);
    if (version.rowCount && version.rows[0].snapshot) return version.rows[0].snapshot;
  }
  if (submission.definition_at_signing && Object.keys(submission.definition_at_signing).length) {
    const definition = submission.definition_at_signing;
    if (definition.form) return definition;
    return { form: definition, fields: definition.fields || [], clauses: [], items: [] };
  }
  const current = await G.getFormDefinition(submission.agreement_id, client);
  return current ? G.snapshotFromDefinition(current) : null;
}

async function bumpTemplateVersion(agreementId, req, client, reason = 'Template edited') {
  const before = await G.getFormDefinition(agreementId, client);
  if (!before) return null;
  await G.ensureVersionSnapshot(agreementId, req.user && req.user.id, client);
  const oldStatus = before.form.approval_status || 'draft';
  const r = await client.query(
    `UPDATE agreement_forms
        SET version=version+1,approval_status='draft',published=false,status='draft',
            reviewed_by=NULL,reviewed_at=NULL,approved_by=NULL,approved_at=NULL,
            published_at=NULL,retired_at=NULL,updated_at=now()
      WHERE id=$1 RETURNING *`, [agreementId]
  );
  await client.query(
    `INSERT INTO agreement_template_approval_history
       (agreement_id,version,from_status,to_status,reviewer_id,reason)
     VALUES($1,$2,$3,'draft',$4,$5)`,
    [agreementId, r.rows[0].version, oldStatus, req.user.id, reason]
  );
  await G.audit({ agreementId, action:'template_new_version', fromStatus:oldStatus,
    toStatus:'draft', reason, details:{ version:r.rows[0].version }, req, client });
  return r.rows[0];
}

async function approvedVersionForCreate(formId, client = pool) {
  const formResult = await client.query('SELECT * FROM agreement_forms WHERE id=$1', [formId]);
  if (!formResult.rowCount) return { form:null, version:null };
  const form = formResult.rows[0];

  // A newer Draft or Legal Review must never disable the last Approved /
  // Published definition. New individual agreements always use the latest
  // approved immutable snapshot until a newer version itself is approved.
  let version = await G.latestApprovedVersion(formId, client);
  if (version) return { form, version };

  // Bootstrap a snapshot only when the current definition itself is approved.
  if (['approved','published'].includes(form.approval_status)) {
    await G.ensureVersionSnapshot(formId, null, client, form.approval_status);
    version = await G.latestApprovedVersion(formId, client);
  }
  return { form, version };
}

async function validateRequiredItems(snapshot, values, submissionId, client = pool) {
  const r = await client.query(
    `SELECT si.*,fi.kind,fi.label,fi.visibility,fi.required,fi.condition_json
       FROM agreement_submission_items si
       JOIN agreement_form_items fi ON fi.id=si.form_item_id
      WHERE si.submission_id=$1`, [submissionId]
  );
  const byId = new Map(r.rows.map((x) => [Number(x.form_item_id), x]));
  for (const item of (snapshot.items || [])) {
    if (item.visibility === 'internal_admin' || !G.itemApplies(item, values)) continue;
    const required = item.required || item.visibility === 'party_b_required';
    if (!required) continue;
    const value = byId.get(Number(item.id));
    if (!value || (item.kind === 'upload' ? !value.upload_url : !value.note_text)) {
      const err = new Error(`“${item.label}” is required.`);
      err.statusCode = 400;
      throw err;
    }
  }
}

async function requiredPartyBSignaturesComplete(submissionId, client = pool) {
  const r = await client.query(
    `SELECT p.id,p.role,p.legal_name,p.required,
            EXISTS(SELECT 1 FROM agreement_signatures s WHERE s.party_id=p.id) AS signed
       FROM agreement_submission_parties p
      WHERE p.submission_id=$1 AND p.party_side='party_b' AND p.required=true`,
    [submissionId]
  );
  if (!r.rowCount) {
    const fallback = await client.query(
      `SELECT EXISTS(SELECT 1 FROM agreement_signatures s
                       WHERE s.submission_id=$1 AND s.party_side='party_b') AS signed`, [submissionId]
    );
    return !!fallback.rows[0].signed;
  }
  return r.rows.every((x) => x.signed);
}

async function renderPdfForSubmission(submission, client = pool) {
  const snapshot = await snapshotForSubmission(submission, client);
  if (!snapshot) return null;
  const answers = asObject(submission.answers);
  const clauses = (Array.isArray(snapshot.clauses) ? snapshot.clauses : [])
    .filter((clause) => G.clauseApplies(clause, answers))
    .map((clause) => ({
      title: clause.title || clause.block_name || 'Agreement clause',
      bodyHtml: clause.body_html || clause.block_body_html || '',
    }));
  return generateAgreementDocument({
    submission,
    fields:Array.isArray(snapshot.fields) ? snapshot.fields : [],
    clauses,
    client,
  });
}

async function notifySubmission(submission, snapshot, pdf, partyBEmail) {
  const form = snapshot.form || {};
  const notify = asObject(submission.notification_config && Object.keys(submission.notification_config).length
    ? submission.notification_config : form.notification_config);
  const delivery = asObject(submission.delivery_config && Object.keys(submission.delivery_config).length
    ? submission.delivery_config : form.delivery_config);
  if (delivery.save_notify_unplug !== false) {
    const recipients = Array.isArray(notify.recipients)
      ? [...new Set(notify.recipients.filter(G.validEmail))] : [];
    for (const to of recipients) {
      await sendEmail({
        to,
        subject:`Agreement submitted — ${submission.reference}`,
        text:`A completed agreement has been submitted.\n\n${form.title || submission.title_at_signing || 'Agreement'}\nReference: ${submission.reference}\nVersion: v${submission.agreement_version}`,
        attachments:pdf ? [{ filename:`${submission.reference}.pdf`, content:pdf }] : undefined,
      });
    }
  }
  if (delivery.email_party_b) {
    const partyBRecipients = new Set();
    if (G.validEmail(partyBEmail)) partyBRecipients.add(String(partyBEmail).toLowerCase());
    if (submission.id) {
      const partyRows = await pool.query(
        `SELECT email FROM agreement_submission_parties
          WHERE submission_id=$1 AND party_side='party_b' AND email IS NOT NULL`,
        [submission.id]
      );
      for (const row of partyRows.rows) if (G.validEmail(row.email)) partyBRecipients.add(String(row.email).toLowerCase());
    }
    for (const to of partyBRecipients) {
      await sendEmail({
        to,
        subject:`${form.title || 'Agreement'} — ${submission.reference}`,
        text:`Thank you. Your agreement has been submitted to Unplug.\nReference: ${submission.reference}\nVersion: v${submission.agreement_version}`,
        attachments:pdf ? [{ filename:`${submission.reference}.pdf`, content:pdf }] : undefined,
      });
    }
  }
}

module.exports = {
  asObject, asArray, cleanRichText, loadSubmission, resolveSignerAccess, assertSignerAccess,
  hasAnySignature, requireInstanceAccess, ensureFormShortCode, snapshotForSubmission,
  bumpTemplateVersion, approvedVersionForCreate, validateRequiredItems,
  requiredPartyBSignaturesComplete, renderPdfForSubmission, notifySubmission,
};
