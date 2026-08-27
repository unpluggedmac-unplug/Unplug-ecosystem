// Chasing a checkout that stalled — carefully, and not very often.
//
// TWO 24-HOUR-APART REMINDERS, THEN IT STOPS. Somebody who has ignored two
// emails about a cart has answered the question. A third is the one that gets
// the sender marked as spam, and that costs the password resets as well.
//
// THE MESSAGE DEPENDS ON WHY IT IS PENDING, and this is the part worth getting
// right:
//
//   payfast / ozow — they bounced off the payment gateway. "You did not
//                    finish" is accurate and the link back is useful.
//   eft            — pending is the CORRECT state. They were given a
//                    reference and are going to their bank, possibly
//                    tomorrow, possibly on payday. Telling this person they
//                    failed is wrong; giving them the reference again is the
//                    single most useful thing, because the usual way an EFT
//                    order dies is the reference being lost.
//   saved cart     — never checked out at all. The gentlest of the three,
//                    because they have not committed to anything.
//
// EVERYTHING GOES OUT THROUGH THE MARKETING SENDER, which means the
// suppression list is checked and every message carries an unsubscribe link.
//
// That is a deliberately conservative reading. A reasonable person could argue
// an EFT reference is transactional — the customer is mid-purchase and asked
// for it. But the purpose of all three of these is to produce a sale, and
// POPIA s69 is about purpose rather than about how the sender feels. Somebody
// who has opted out of our marketing and still wants their reference can see
// it in their dashboard, where it has always been.

const pool = require('../db');
const marketing = require('./emailMarketing');
const renderer = require('./emailRenderer');

const SITE_URL = (process.env.SITE_URL || 'https://www.unplugnews.com').replace(/\/$/, '');

// The first goes after a day, not after an hour. An hour catches somebody who
// stepped away for lunch and reads as surveillance.
const FIRST_AFTER_HOURS = 24;
const SECOND_AFTER_HOURS = 72;
const MAX_REMINDERS = 2;

// Nothing older than this is ever chased. A cart from six weeks ago is not a
// live intention, and an email about it is a surprise rather than a nudge.
const GIVE_UP_AFTER_DAYS = 30;

function hoursFor(sent) {
  return sent === 0 ? FIRST_AFTER_HOURS : SECOND_AFTER_HOURS;
}

// ---------------------------------------------------------------------------
// The messages
// ---------------------------------------------------------------------------

function orderBlocks({ name, order, itemLines }) {
  const greeting = name ? `Hi ${name},` : 'Hi,';
  const isEft = order.method === 'eft';

  if (isEft) {
    return [
      { type: 'heading', text: 'Your payment reference', level: 2 },
      { type: 'text', text: `${greeting}\n\nYour order is waiting on an EFT, which is exactly `
        + 'where it should be — here is the reference again so you have it to hand when you '
        + 'make the transfer.' },
      { type: 'text', text: `**Reference: ${order.reference}**\n**Amount: R${Number(order.total).toFixed(2)}**` },
      { type: 'text', text: 'Please use that reference on the transfer — it is how we match your '
        + 'payment to your order. Everything is held for you until it arrives.' },
      ...(itemLines ? [{ type: 'text', text: itemLines }] : []),
      { type: 'divider' },
      { type: 'button', label: 'See your order', href: `${SITE_URL}/unplug-member-dashboard.html` },
      { type: 'text', text: 'Already paid? Then ignore this — it can take a day or two for a '
        + 'transfer to reach us and be matched up.' },
    ];
  }

  return [
    { type: 'heading', text: 'Your order is still waiting', level: 2 },
    { type: 'text', text: `${greeting}\n\nYou started an order with us and the payment did not `
      + 'come through. Nothing has been charged, and everything you chose is still held.' },
    ...(itemLines ? [{ type: 'text', text: itemLines }] : []),
    { type: 'text', text: `**Reference: ${order.reference}**\n`
      + `**Total: R${Number(order.total).toFixed(2)}**` },
    { type: 'divider' },
    { type: 'button', label: 'Finish your order', href: `${SITE_URL}/unplug-member-dashboard.html` },
    { type: 'text', text: 'If you changed your mind, no need to do anything — it will simply '
      + 'lapse.' },
  ];
}

function cartBlocks({ name, count }) {
  const greeting = name ? `Hi ${name},` : 'Hi,';
  return [
    { type: 'heading', text: 'You left something with us', level: 2 },
    { type: 'text', text: `${greeting}\n\nThere ${count === 1 ? 'is 1 service' : `are ${count} services`} `
      + 'sitting in your Unplug cart. Nothing has been charged and nothing is reserved — '
      + 'it is just still there if you want it.' },
    { type: 'divider' },
    { type: 'button', label: 'Pick up where you left off', href: `${SITE_URL}/unplug-member-dashboard.html` },
    { type: 'text', text: 'If you have changed your mind, you can ignore this — we will not '
      + 'write about it again.' },
  ];
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

// Claims one due order by moving its reminder count forward in the same
// statement that finds it. Same rule as the campaign scheduler: two overlapping
// runs must not both send, and the count moving first means a crash loses a
// reminder rather than sending two.
async function claimDueOrder() {
  const r = await pool.query(`
    UPDATE orders
       SET reminders_sent = reminders_sent + 1, last_reminded_at = now()
     WHERE id = (
       SELECT o.id FROM orders o
        WHERE o.status = 'pending'
          AND o.recovery_opted_out = false
          AND o.reminders_sent < $1
          AND o.created_at > now() - ($4 || ' days')::interval
          AND o.created_at < now() - (CASE WHEN o.reminders_sent = 0 THEN $2 ELSE $3 END || ' hours')::interval
          AND (o.last_reminded_at IS NULL
               OR o.last_reminded_at < now() - ($2 || ' hours')::interval)
        ORDER BY o.created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1)
    RETURNING *`,
  [MAX_REMINDERS, String(FIRST_AFTER_HOURS), String(SECOND_AFTER_HOURS), String(GIVE_UP_AFTER_DAYS)]);
  return r.rowCount ? r.rows[0] : null;
}

async function sendOrderReminder(order) {
  const user = await pool.query('SELECT email, full_name FROM users WHERE id = $1', [order.user_id]);
  if (user.rowCount === 0) return { orderId: order.id, skipped: 'no such user' };

  const items = await pool.query(
    `SELECT linked_type, amount FROM payments WHERE order_id = $1 ORDER BY id`, [order.id]);
  const itemLines = items.rowCount
    ? items.rows.map((i) => `• ${String(i.linked_type).replace(/_/g, ' ')} — R${Number(i.amount).toFixed(2)}`).join('\n')
    : '';

  const firstName = String(user.rows[0].full_name || '').trim().split(/\s+/)[0] || '';
  const blocks = orderBlocks({ name: firstName, order, itemLines });
  const subject = order.method === 'eft'
    ? `Your payment reference: ${order.reference}`
    : 'Your Unplug order is still waiting';

  const { html, text } = renderer.render({ subject, blocks });
  const result = await marketing.sendOne({ email: user.rows[0].email, subject, html, text });
  return { orderId: order.id, method: order.method, status: result.status };
}

// ---------------------------------------------------------------------------
// Saved carts
// ---------------------------------------------------------------------------

async function claimDueCart() {
  const r = await pool.query(`
    UPDATE saved_carts
       SET reminders_sent = reminders_sent + 1, last_reminded_at = now()
     WHERE user_id = (
       SELECT c.user_id FROM saved_carts c
        WHERE c.converted_at IS NULL
          AND c.reminders_sent < $1
          -- The type check comes FIRST and is not decoration. items is a JSONB
          -- column, so it can in principle hold an object or a string, and
          -- jsonb_array_length THROWS on anything that is not an array rather
          -- than returning null. One such row would make this query fail every
          -- hour from then on, and the failure would be silent — carts simply
          -- stop being chased and nobody notices a thing that never happens.
          AND jsonb_typeof(c.items) = 'array'
          AND jsonb_array_length(c.items) > 0
          AND c.updated_at > now() - ($4 || ' days')::interval
          AND c.updated_at < now() - (CASE WHEN c.reminders_sent = 0 THEN $2 ELSE $3 END || ' hours')::interval
          AND (c.last_reminded_at IS NULL
               OR c.last_reminded_at < now() - ($2 || ' hours')::interval)
        ORDER BY c.updated_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1)
    RETURNING *`,
  [MAX_REMINDERS, String(FIRST_AFTER_HOURS), String(SECOND_AFTER_HOURS), String(GIVE_UP_AFTER_DAYS)]);
  return r.rowCount ? r.rows[0] : null;
}

async function sendCartReminder(cart) {
  const user = await pool.query('SELECT email, full_name FROM users WHERE id = $1', [cart.user_id]);
  if (user.rowCount === 0) return { userId: cart.user_id, skipped: 'no such user' };

  // SOMEBODY WITH A PENDING ORDER IS NOT CHASED ABOUT THEIR CART AS WELL.
  // They are already being written to about the same purchase, and two emails
  // about one intention is how a helpful nudge becomes a nuisance.
  const pending = await pool.query(
    `SELECT 1 FROM orders WHERE user_id = $1 AND status = 'pending' LIMIT 1`, [cart.user_id]);
  if (pending.rowCount) return { userId: cart.user_id, skipped: 'already being chased about an order' };

  const count = Array.isArray(cart.items) ? cart.items.length : 0;
  if (!count) return { userId: cart.user_id, skipped: 'empty' };

  const firstName = String(user.rows[0].full_name || '').trim().split(/\s+/)[0] || '';
  const subject = 'You left something in your Unplug cart';
  const { html, text } = renderer.render({ subject, blocks: cartBlocks({ name: firstName, count }) });
  const result = await marketing.sendOne({ email: user.rows[0].email, subject, html, text });
  return { userId: cart.user_id, status: result.status };
}

// ---------------------------------------------------------------------------
// One pass
// ---------------------------------------------------------------------------

// ONE OF EACH PER RUN. This runs hourly and the thresholds are measured in
// days, so there is no need to burst through a backlog — and doing so on a
// 512 MB instance is how the magazine slows down for everybody so that four
// people can be reminded a minute sooner.
async function run() {
  const out = { orders: [], carts: [] };

  try {
    const order = await claimDueOrder();
    if (order) out.orders.push(await sendOrderReminder(order));
  } catch (err) {
    console.error('[recovery] order reminder failed:', err.message);
  }

  try {
    const cart = await claimDueCart();
    if (cart) out.carts.push(await sendCartReminder(cart));
  } catch (err) {
    console.error('[recovery] cart reminder failed:', err.message);
  }

  return out;
}

// Hourly. The thresholds are 24 and 72 hours, so a reminder landing within an
// hour of its mark is close enough, and it keeps the query off a sleeping
// instance the rest of the time.
const INTERVAL_MS = 60 * 60 * 1000;
let timer = null;

function start() {
  if (timer) return timer;
  timer = setInterval(() => {
    run()
      .then((r) => {
        const n = r.orders.filter((x) => x.status === 'sent').length
          + r.carts.filter((x) => x.status === 'sent').length;
        if (n) console.log(`[recovery] sent ${n} reminder(s)`);
      })
      .catch((err) => console.error('[recovery] run failed:', err.message));
  }, INTERVAL_MS);
  if (timer.unref) timer.unref();
  return timer;
}

function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = {
  run, start, stop,
  claimDueOrder, sendOrderReminder, claimDueCart, sendCartReminder,
  orderBlocks, cartBlocks,
  FIRST_AFTER_HOURS, SECOND_AFTER_HOURS, MAX_REMINDERS, GIVE_UP_AFTER_DAYS, INTERVAL_MS,
};
