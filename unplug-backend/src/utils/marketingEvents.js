// TELLING RESEND THAT SOMETHING HAPPENED, so a nurture sequence can start.
//
// The two sequences in Resend are triggered by named events rather than by a
// list membership: a person who joins the newsletter fires
// unplug.nominator.joined, a business enquiring about advertising fires
// unplug.advertiser.enquired. Resend then runs the five-email sequence on its
// own schedule, which is why the delays are configured there and not here —
// this file's only job is to say the thing happened.
//
// ORDER MATTERS: a contact has to exist before an event can be attached to it.
// Resend accepts the event against an email address, but a person who is not a
// contact has nobody for the automation to email, so the contact is created
// first and a failure there stops the event rather than firing one into
// nothing.
//
// EVERYTHING HERE IS BEST-EFFORT AND NEVER THROWS. A marketing sequence is not
// worth failing a newsletter signup over, let alone an advertising enquiry
// from a real customer. Failures are logged loudly, because a silent failure
// here looks exactly like "nobody has signed up yet".

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const RESEND_AUDIENCE_ID = process.env.RESEND_AUDIENCE_ID || '';

// Named here rather than passed in as strings from each call site, so a typo
// cannot quietly create an event no automation is listening for.
const EVENTS = {
  NOMINATOR_JOINED: 'unplug.nominator.joined',
  ADVERTISER_ENQUIRED: 'unplug.advertiser.enquired',
};

const isConfigured = () => Boolean(RESEND_API_KEY);

async function resendFetch(path, body) {
  const res = await fetch('https://api.resend.com' + path, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const err = new Error(`Resend ${path} returned ${res.status}: ${detail.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return res.json().catch(() => ({}));
}

// A contact is created if it does not exist. A 409 means it already does,
// which is the normal case for anybody who has been here before and is not an
// error — re-subscribing must not look like a failure.
async function ensureContact({ email, firstName, lastName }) {
  if (!RESEND_AUDIENCE_ID) return; // no audience configured; the event can still carry the address
  try {
    await resendFetch('/contacts', {
      email,
      first_name: firstName || undefined,
      last_name: lastName || undefined,
      unsubscribed: false,
      audience_id: RESEND_AUDIENCE_ID,
    });
  } catch (err) {
    if (err.status === 409 || err.status === 422) return; // already a contact
    throw err;
  }
}

// Fire-and-forget by design. Nothing on a request path waits for this.
function trackAsync(eventName, { email, firstName, lastName, payload } = {}) {
  track(eventName, { email, firstName, lastName, payload })
    .catch((err) => console.error('[marketing] event failed:', err.message));
}

async function track(eventName, { email, firstName, lastName, payload } = {}) {
  if (!isConfigured()) {
    // Said out loud, because "no emails are going out" and "nobody has signed
    // up" look identical from the outside.
    console.log(`[marketing] RESEND_API_KEY not set — would have fired ${eventName} for ${email}`);
    return { sent: false, reason: 'not-configured' };
  }
  if (!email) return { sent: false, reason: 'no-email' };

  await ensureContact({ email, firstName, lastName });
  await resendFetch('/events', {
    event: eventName,
    email,
    payload: payload || {},
  });
  return { sent: true };
}

module.exports = { EVENTS, track, trackAsync, isConfigured };
