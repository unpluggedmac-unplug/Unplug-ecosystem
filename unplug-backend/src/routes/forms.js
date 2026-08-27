// The form builder: composing forms, and collecting what people put in them.
//
// NOTHING HERE REIMPLEMENTS WHAT ALREADY EXISTS. The honeypot, the rate
// limiter, the spam scorer, CRM capture and the admin notification are all
// built and are wired to this. What is new is only the definition of a form
// and the answers people give.
//
// THE ANSWERS ARE VALIDATED AGAINST THE FORM, not trusted. A submission is a
// public POST of arbitrary JSON: the fields it claims to answer are checked
// against the fields the form actually has, unknown keys are dropped, required
// ones are enforced, and lengths are cut to what the column can hold. Storing
// whatever arrived would make this endpoint a way to write arbitrary JSON into
// the database.

const express = require('express');
const pool = require('../db');
const { requireRole, attachUser } = require('../middleware/auth');
const { publicSubmitLimiter } = require('../middleware/rateLimit');
const honeypot = require('../middleware/honeypot');
const { spamCheck } = require('../middleware/spamCheck');
const { logActivity } = require('./activityLog');
const capture = require('../utils/crmCapture');
const requestContext = require('../middleware/requestContext');
const { notifyAdminAsync, NOTIFY } = require('../utils/adminNotify');
const { isPublicStorageUrl } = require('./uploads');

const router = express.Router();

const KINDS = ['text', 'email', 'phone', 'textarea', 'number', 'date',
  'select', 'radio', 'checkbox', 'file'];

const trim = (v, max) => (v === null || v === undefined ? null : String(v).trim().slice(0, max) || null);

function slugify(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '').slice(0, 80);
}

// A form is live only if it is switched on AND inside its window. Both are
// checked here rather than in the page, because the page can be edited by
// whoever is looking at it.
function liveState(form) {
  const now = Date.now();
  if (!form.active) return { live: false, reason: 'not-open' };
  if (form.opens_at && new Date(form.opens_at).getTime() > now) return { live: false, reason: 'not-yet' };
  if (form.closes_at && new Date(form.closes_at).getTime() <= now) return { live: false, reason: 'closed' };
  return { live: true };
}

async function fieldsFor(formId) {
  const r = await pool.query(
    'SELECT * FROM form_fields WHERE form_id = $1 ORDER BY position, id', [formId]);
  return r.rows;
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

// GET /forms/:slug — the definition, for rendering.
router.get('/:slug', async (req, res, next) => {
  try {
    const r = await pool.query('SELECT * FROM forms WHERE LOWER(slug) = LOWER($1)', [req.params.slug]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'No such form.' });
    const form = r.rows[0];
    const state = liveState(form);

    // A closed form still answers, with its closed message. A 404 would tell
    // somebody following a link from an email that the page is broken, when
    // what actually happened is that they are a week late.
    if (!state.live) {
      return res.status(200).json({
        slug: form.slug,
        title: form.title,
        open: false,
        reason: state.reason,
        message: form.closed_message
          || (state.reason === 'not-yet'
            ? 'This form is not open yet.'
            : 'This form has closed. Thank you to everybody who took part.'),
      });
    }

    const fields = await fieldsFor(form.id);
    res.set('Cache-Control', 'public, max-age=60');
    res.json({
      slug: form.slug,
      title: form.title,
      intro: form.intro,
      open: true,
      amount: form.amount === null ? null : Number(form.amount),
      // Told to the browser so it can ask somebody to sign in BEFORE they fill
      // in nine fields and then find out they cannot attach the document.
      requiresMember: fields.some((f) => f.kind === 'file'),
      fields: fields.map((f) => ({
        key: f.field_key,
        kind: f.kind,
        label: f.label,
        placeholder: f.placeholder,
        help: f.help,
        required: f.required,
        options: Array.isArray(f.options) ? f.options : [],
        maxLength: f.max_length,
      })),
    });
  } catch (err) { next(err); }
});

// POST /forms/:slug — a submission.
router.post('/:slug', publicSubmitLimiter, attachUser, honeypot,
  spamCheck('form submission'), async (req, res, next) => {
    try {
      const r = await pool.query('SELECT * FROM forms WHERE LOWER(slug) = LOWER($1)', [req.params.slug]);
      if (r.rowCount === 0) return res.status(404).json({ error: 'No such form.' });
      const form = r.rows[0];

      // CHECKED AGAIN AT SUBMIT. The form was open when the page was loaded;
      // it may not be now, and a closing date that only applies while somebody
      // has the tab open is not a closing date.
      const state = liveState(form);
      if (!state.live) {
        return res.status(410).json({
          error: form.closed_message || 'This form is no longer accepting answers.',
        });
      }

      const fields = await fieldsFor(form.id);
      const given = (req.body && typeof req.body.answers === 'object' && req.body.answers) || {};

      const answers = {};
      for (const field of fields) {
        const raw = given[field.field_key];

        if (field.kind === 'checkbox') {
          const on = raw === true || raw === 'true' || raw === 'on';
          if (field.required && !on) {
            return res.status(400).json({ error: `Please tick “${field.label}”.` });
          }
          answers[field.field_key] = on;
          continue;
        }

        if (field.kind === 'file') {
          // Same rule as the share card photo: a file needs an account,
          // because an unauthenticated upload that becomes publicly readable
          // is free image hosting for whoever finds the endpoint.
          if (raw && !req.user) {
            return res.status(401).json({ error: 'Sign in as a member to attach a file.' });
          }
          const url = trim(raw, 500);
          if (field.required && !url) {
            return res.status(400).json({ error: `“${field.label}” needs a file.` });
          }
          if (url && !isPublicStorageUrl(url)) {
            return res.status(400).json({ error: 'That file was not uploaded here. Please choose it again.' });
          }
          answers[field.field_key] = url;
          continue;
        }

        const value = trim(raw, Math.min(Number(field.max_length) || 2000, 5000));
        if (field.required && !value) {
          return res.status(400).json({ error: `“${field.label}” is required.` });
        }
        if (value && field.kind === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
          return res.status(400).json({ error: `“${field.label}” does not look like an email address.` });
        }
        // A select or radio may only answer with something it actually offers.
        if (value && (field.kind === 'select' || field.kind === 'radio')) {
          const options = Array.isArray(field.options) ? field.options : [];
          if (options.length && !options.includes(value)) {
            return res.status(400).json({ error: `“${value}” is not one of the choices for “${field.label}”.` });
          }
        }
        answers[field.field_key] = value;
      }

      // Lifted out so the CRM, the export and the submissions list have
      // something to work with without guessing which field held the address.
      const emailField = fields.find((f) => f.kind === 'email');
      const email = emailField ? answers[emailField.field_key] : null;
      const nameField = fields.find((f) => /name/i.test(f.label) && f.kind === 'text');
      const fullName = nameField ? answers[nameField.field_key] : null;

      const inserted = await pool.query(
        `INSERT INTO form_submissions (form_id, answers, email, full_name, user_id, ip)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at`,
        [form.id, JSON.stringify(answers), email, fullName,
          req.user ? req.user.id : null, requestContext.current().ip || null]);

      // Onto the CRM timeline, the same way the contact form already does, so
      // one person remains one contact rather than becoming a stranger every
      // time they fill something in.
      if (email) {
        capture.captureSubmission({
          email,
          fullName,
          formName: form.name,
          message: Object.entries(answers)
            .filter(([, v]) => v && typeof v === 'string')
            .map(([k, v]) => `${k}: ${v}`).join('\n')
            .slice(0, 4000),
          userId: req.user ? req.user.id : null,
        }).catch((e) => console.error('[forms] CRM capture failed:', e.message));
      }

      // ENQUIRY rather than a new type. A form response is an enquiry in every
      // way that matters to whoever reads the notification list, and adding a
      // type the admin screen has no label or icon for would show up there as
      // a blank row.
      //
      // Rolled up per form: a survey that gets two hundred answers in an hour
      // must not push everything else off the notification list.
      notifyAdminAsync({
        type: NOTIFY.ENQUIRY,
        message: `New response to “${form.name}”`,
        plural: `%n new responses to “${form.name}”`,
        detail: email || 'no email given',
        link: 'forms',
        dedupeKey: 'form:' + form.id,
      });

      res.status(201).json({
        id: inserted.rows[0].id,
        message: form.success_message || 'Thank you — we have got that.',
      });
    } catch (err) { next(err); }
  });

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

router.get('/', requireRole('admin'), async (req, res, next) => {
  try {
    const r = await pool.query(`
      SELECT f.*,
             (SELECT count(*)::int FROM form_fields ff WHERE ff.form_id = f.id) AS field_count,
             (SELECT count(*)::int FROM form_submissions s WHERE s.form_id = f.id) AS submission_count,
             (SELECT count(*)::int FROM form_submissions s WHERE s.form_id = f.id AND s.status = 'new') AS unread
        FROM forms f
       ORDER BY f.active DESC, f.created_at DESC`);
    res.json(r.rows);
  } catch (err) { next(err); }
});

router.get('/admin/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const f = await pool.query('SELECT * FROM forms WHERE id = $1', [req.params.id]);
    if (f.rowCount === 0) return res.status(404).json({ error: 'No such form.' });
    res.json({ ...f.rows[0], fields: await fieldsFor(req.params.id) });
  } catch (err) { next(err); }
});

router.post('/', requireRole('admin'), async (req, res, next) => {
  try {
    const name = trim(req.body.name, 160);
    const title = trim(req.body.title, 200) || name;
    if (!name) return res.status(400).json({ error: 'The form needs a name.' });
    const slug = slugify(req.body.slug || name);
    if (!slug) return res.status(400).json({ error: 'That name does not make a usable address.' });

    const r = await pool.query(
      `INSERT INTO forms (name, slug, title, intro, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [name, slug, title, trim(req.body.intro, 4000), req.user.id]);
    await logActivity(req.user.id, 'form_created', `Created the form "${name}"`);
    res.status(201).json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A form already uses that address.' });
    next(err);
  }
});

router.patch('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const fields = [];
    const values = [];
    const set = (col, val) => { values.push(val); fields.push(`${col} = $${values.length}`); };

    if (req.body.name !== undefined) set('name', trim(req.body.name, 160));
    if (req.body.title !== undefined) set('title', trim(req.body.title, 200));
    if (req.body.intro !== undefined) set('intro', trim(req.body.intro, 4000));
    if (req.body.successMessage !== undefined) set('success_message', trim(req.body.successMessage, 2000));
    if (req.body.closedMessage !== undefined) set('closed_message', trim(req.body.closedMessage, 2000));
    if (req.body.notifyEmail !== undefined) set('notify_email', trim(req.body.notifyEmail, 255));
    if (req.body.opensAt !== undefined) set('opens_at', req.body.opensAt || null);
    if (req.body.closesAt !== undefined) set('closes_at', req.body.closesAt || null);
    if (req.body.amount !== undefined) {
      const amount = req.body.amount === null || req.body.amount === '' ? null
        : Math.max(0, Number(req.body.amount) || 0);
      set('amount', amount);
    }
    if (req.body.slug !== undefined) {
      const slug = slugify(req.body.slug);
      if (!slug) return res.status(400).json({ error: 'That address is not usable.' });
      set('slug', slug);
    }

    if (req.body.active !== undefined) {
      // Switching a form ON is the moment it starts collecting answers from
      // real people, so it is refused until there is something to answer.
      if (req.body.active) {
        const count = await pool.query(
          'SELECT count(*)::int AS n FROM form_fields WHERE form_id = $1', [req.params.id]);
        if (count.rows[0].n === 0) {
          return res.status(400).json({ error: 'Add at least one question before switching this on.' });
        }
      }
      set('active', !!req.body.active);
    }

    if (!fields.length) return res.status(400).json({ error: 'Nothing to change.' });
    fields.push('updated_at = now()');
    values.push(req.params.id);

    const r = await pool.query(
      `UPDATE forms SET ${fields.join(', ')} WHERE id = $${values.length} RETURNING *`, values);
    if (r.rowCount === 0) return res.status(404).json({ error: 'No such form.' });

    if (req.body.active !== undefined) {
      await logActivity(req.user.id, req.body.active ? 'form_opened' : 'form_closed',
        `${req.body.active ? 'Opened' : 'Closed'} the form "${r.rows[0].name}"`);
    }
    res.json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A form already uses that address.' });
    next(err);
  }
});

router.delete('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    // A form with answers in it is not deleted casually — the answers go with
    // it, and somebody's bursary application is not ours to throw away.
    const subs = await pool.query(
      'SELECT count(*)::int AS n FROM form_submissions WHERE form_id = $1', [req.params.id]);
    if (subs.rows[0].n > 0 && req.query.confirm !== 'delete-the-answers-too') {
      return res.status(409).json({
        error: `That form has ${subs.rows[0].n} response(s). Export them first — deleting the form deletes them too.`,
      });
    }
    const r = await pool.query('DELETE FROM forms WHERE id = $1 RETURNING name', [req.params.id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'No such form.' });
    await logActivity(req.user.id, 'form_deleted', `Deleted the form "${r.rows[0].name}"`);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// --- fields ---------------------------------------------------------------

router.post('/:id/fields', requireRole('admin'), async (req, res, next) => {
  try {
    const kind = KINDS.includes(req.body.kind) ? req.body.kind : 'text';
    const label = trim(req.body.label, 200);
    if (!label) return res.status(400).json({ error: 'The question needs a label.' });

    // The key is derived from the label once, at creation, and then never
    // changes — answers are stored against it, and renaming the label later
    // must not orphan everything already collected.
    const key = slugify(req.body.fieldKey || label).replace(/-/g, '_') || ('field_' + Date.now());

    const r = await pool.query(
      `INSERT INTO form_fields (form_id, position, kind, field_key, label, placeholder, help, required, options, max_length)
       VALUES ($1,
               COALESCE((SELECT max(position) FROM form_fields WHERE form_id = $1), 0) + 1,
               $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [req.params.id, kind, key, label, trim(req.body.placeholder, 200), trim(req.body.help, 500),
        !!req.body.required,
        JSON.stringify(Array.isArray(req.body.options) ? req.body.options.slice(0, 40) : []),
        req.body.maxLength ? Math.min(5000, Math.max(1, Number(req.body.maxLength))) : null]);
    res.status(201).json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That question already exists on this form.' });
    next(err);
  }
});

router.patch('/:id/fields/:fieldId', requireRole('admin'), async (req, res, next) => {
  try {
    const sets = [];
    const values = [];
    const set = (col, val) => { values.push(val); sets.push(`${col} = $${values.length}`); };
    if (req.body.label !== undefined) set('label', trim(req.body.label, 200));
    if (req.body.placeholder !== undefined) set('placeholder', trim(req.body.placeholder, 200));
    if (req.body.help !== undefined) set('help', trim(req.body.help, 500));
    if (req.body.required !== undefined) set('required', !!req.body.required);
    if (req.body.position !== undefined) set('position', Number(req.body.position) || 1);
    if (req.body.options !== undefined) {
      set('options', JSON.stringify(Array.isArray(req.body.options) ? req.body.options.slice(0, 40) : []));
    }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to change.' });

    values.push(req.params.fieldId, req.params.id);
    const r = await pool.query(
      `UPDATE form_fields SET ${sets.join(', ')}
        WHERE id = $${values.length - 1} AND form_id = $${values.length} RETURNING *`, values);
    if (r.rowCount === 0) return res.status(404).json({ error: 'No such question.' });
    res.json(r.rows[0]);
  } catch (err) { next(err); }
});

router.delete('/:id/fields/:fieldId', requireRole('admin'), async (req, res, next) => {
  try {
    const r = await pool.query(
      'DELETE FROM form_fields WHERE id = $1 AND form_id = $2 RETURNING field_key',
      [req.params.fieldId, req.params.id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'No such question.' });
    // The ANSWERS are deliberately left alone. They are keyed by field_key and
    // stay in the JSON, so removing a question from the form does not erase
    // what people already told us through it.
    res.json({ ok: true, note: 'Answers already collected for that question are kept.' });
  } catch (err) { next(err); }
});

// --- submissions ----------------------------------------------------------

router.get('/:id/submissions', requireRole('admin'), async (req, res, next) => {
  try {
    const r = await pool.query(`
      -- gateway_reference, NOT reference. I guessed the column name and the
      -- endpoint returned 500 for every response list until a browser hit it —
      -- the same mistake as reading utm_source off a table whose column is
      -- called source. The join is checked by a test now.
      SELECT s.*, p.status AS payment_status, p.gateway_reference AS payment_reference
        FROM form_submissions s
        LEFT JOIN payments p ON p.id = s.payment_id
       WHERE s.form_id = $1
       ORDER BY s.created_at DESC LIMIT 500`, [req.params.id]);
    res.json({ fields: await fieldsFor(req.params.id), submissions: r.rows });
  } catch (err) { next(err); }
});

// CSV, because the first thing anybody does with a pile of applications is
// open them in a spreadsheet.
router.get('/:id/submissions.csv', requireRole('admin'), async (req, res, next) => {
  try {
    const fields = await fieldsFor(req.params.id);
    const r = await pool.query(
      'SELECT * FROM form_submissions WHERE form_id = $1 ORDER BY created_at', [req.params.id]);

    // A leading =, +, - or @ makes a spreadsheet treat the cell as a formula.
    // That is a real way to attack whoever opens the export, and the value
    // came from a public form.
    const cell = (v) => {
      let s = v === null || v === undefined ? '' : String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return '"' + s.replace(/"/g, '""') + '"';
    };

    const header = ['Submitted', 'Email', 'Name', ...fields.map((f) => f.label)];
    const lines = [header.map(cell).join(',')];
    r.rows.forEach((row) => {
      const answers = row.answers || {};
      lines.push([
        row.created_at.toISOString(),
        row.email || '',
        row.full_name || '',
        ...fields.map((f) => {
          const v = answers[f.field_key];
          return v === true ? 'Yes' : v === false ? 'No' : (v || '');
        }),
      ].map(cell).join(','));
    });

    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="form-${req.params.id}-responses.csv"`);
    res.send(lines.join('\r\n'));
  } catch (err) { next(err); }
});

router.patch('/:id/submissions/:submissionId', requireRole('admin'), async (req, res, next) => {
  try {
    const status = ['new', 'read', 'actioned', 'archived'].includes(req.body.status)
      ? req.body.status : null;
    if (!status) return res.status(400).json({ error: 'Unknown status.' });
    const r = await pool.query(
      `UPDATE form_submissions SET status = $1 WHERE id = $2 AND form_id = $3 RETURNING id`,
      [status, req.params.submissionId, req.params.id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'No such response.' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
