// The individual spam signals: what each one looks for, and what it is worth.
//
// NO SINGLE SIGNAL DECIDES ANYTHING. Each returns a small number of points,
// and the sum is compared against a threshold an admin can move. That is
// deliberate — every one of these has a false positive that a real person will
// eventually trigger:
//
//   - Somebody types a genuine enquiry entirely in capitals because they are
//     older and that is how they were taught.
//   - A business owner's contact email is at a domain nobody has heard of.
//   - A nomination legitimately contains two links, to the person's Facebook
//     and their shop.
//   - Somebody writes a very short comment. "Beautiful." is a real comment.
//
// Any of those alone must never be enough. Three of them together, plus a
// submission filled in one second flat, is a different matter.
//
// THE AUDIENCE SHAPES THE THRESHOLDS. This is a South African community
// magazine. Its readers write in English, Afrikaans, isiZulu and more; they
// type on phones; they are not native English copywriters. Signals that
// amount to "this does not read like an American marketing email" would
// penalise exactly the people the magazine exists for, so there are none here.

// A link or two is normal. Six is a catalogue.
const LINK_RE = /https?:\/\/|www\.[a-z0-9-]+\.[a-z]{2,}/gi;

// Phrases that are close to meaningless outside of spam. Deliberately short:
// every entry here is a phrase this magazine would never publish in a comment
// or a nomination, and each is worth only a few points so that one unlucky
// match cannot condemn a submission.
//
// Notably absent: "loan", "insurance", "crypto", "casino". This site sells
// advertising, and an enquiry that says "we are a loan company and would like
// to advertise" is a CUSTOMER, not spam.
const SPAM_PHRASES = [
  'viagra', 'cialis', 'porn', 'xxx video',
  'seo services', 'guest post', 'backlink', 'link building',
  'increase your traffic', 'rank #1 on google', 'first page of google',
  'work from home and earn', 'make $', 'earn $', 'binary option',
  'forex signals', 'bitcoin doubler', 'investment opportunity guaranteed',
  'click here now', 'limited time offer act now',
  'dear sir/madam i am writing to inform you that you have won',
];

// Throwaway inboxes. A short list of the common ones rather than a downloaded
// database: this is a signal worth a few points, not a verdict, and a
// dependency that fetches a list of ten thousand domains is a dependency that
// can go down and take the contact form with it.
const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.net', '10minutemail.com',
  'tempmail.com', 'temp-mail.org', 'throwawaymail.com', 'yopmail.com',
  'sharklasers.com', 'trashmail.com', 'getnada.com', 'dispostable.com',
  'maildrop.cc', 'fakeinbox.com', 'mailnesia.com', 'spamgourmet.com',
  'mintemail.com', 'mytemp.email', 'emailondeck.com', 'moakt.com',
]);

function textOf(fields) {
  return Object.values(fields || {})
    .filter((v) => typeof v === 'string')
    .join(' \n ');
}

// --- individual checks ------------------------------------------------------
// Each returns { name, points, detail } or null when it did not fire.

function checkHoneypot(submission) {
  const trap = submission.fields && submission.fields.website;
  if (typeof trap === 'string' && trap.trim() !== '') {
    // The one signal that IS conclusive. A human never sees this field, so
    // filling it takes a program. Nothing legitimate does this.
    return { name: 'honeypot', points: 100, detail: 'a field invisible to people was filled in' };
  }
  return null;
}

function checkSpeed(submission) {
  const ms = Number(submission.elapsedMs);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  // Under two seconds from the form appearing to it being sent. Nobody reads a
  // form, decides what to say and types it in two seconds — but somebody
  // pasting a prepared sentence might take four, so the bar is low.
  if (ms < 2000) {
    return { name: 'too_fast', points: 35, detail: `submitted ${(ms / 1000).toFixed(1)}s after the form loaded` };
  }
  if (ms < 4000) {
    return { name: 'fast', points: 10, detail: `submitted ${(ms / 1000).toFixed(1)}s after the form loaded` };
  }
  return null;
}

function checkNoJs(submission) {
  // The form issues a token that only its JavaScript can attach. A submission
  // without one came from something that posted directly to the endpoint.
  //
  // Only 20 points: a reader with JavaScript disabled, or a browser extension
  // that strips it, is unusual but not a bot, and this must not be enough on
  // its own to bury them.
  if (submission.jsTokenValid === false) {
    return { name: 'no_js_token', points: 20, detail: 'posted without the token the form issues' };
  }
  return null;
}

function checkLinks(submission) {
  const text = textOf(submission.fields);
  const links = text.match(LINK_RE) || [];
  if (links.length >= 5) {
    return { name: 'many_links', points: 30, detail: `${links.length} links` };
  }
  if (links.length >= 3) {
    return { name: 'several_links', points: 12, detail: `${links.length} links` };
  }
  return null;
}

function checkPhrases(submission) {
  const text = textOf(submission.fields).toLowerCase();
  const found = SPAM_PHRASES.filter((p) => text.includes(p));
  if (!found.length) return null;
  // Capped: three matches is as damning as ten, and the cap stops a long
  // quoted spam email — which somebody might legitimately forward to the
  // contact form to report it — from scoring off the scale.
  return {
    name: 'spam_phrases',
    points: Math.min(45, found.length * 15),
    detail: found.slice(0, 3).join(', '),
  };
}

function checkEmail(submission) {
  const email = String((submission.fields && submission.fields.email) || '').toLowerCase().trim();
  if (!email.includes('@')) return null;
  const domain = email.split('@').pop();
  if (DISPOSABLE_DOMAINS.has(domain)) {
    return { name: 'disposable_email', points: 25, detail: domain };
  }
  return null;
}

function checkShouting(submission) {
  const text = textOf(submission.fields);
  const letters = text.replace(/[^a-zA-Z]/g, '');
  // Needs enough letters to mean anything — "OK" and "ASAP" are not shouting.
  if (letters.length < 40) return null;
  const upper = (text.match(/[A-Z]/g) || []).length;
  const ratio = upper / letters.length;
  if (ratio > 0.7) {
    // Only 8 points. Plenty of people type in capitals, particularly older
    // readers and particularly on phones. It is a hint, nothing more.
    return { name: 'all_caps', points: 8, detail: `${Math.round(ratio * 100)}% capitals` };
  }
  return null;
}

function checkGibberish(submission) {
  const text = textOf(submission.fields);
  // The same character eight times over is a keyboard mash or padding.
  if (/(.)\1{7,}/.test(text)) {
    return { name: 'repeated_characters', points: 15, detail: 'a character repeated eight or more times' };
  }
  return null;
}

// Everything, in one place, so the set can be listed and explained on the
// admin screen rather than being knowledge locked in this file.
const SIGNALS = [
  checkHoneypot, checkSpeed, checkNoJs, checkLinks,
  checkPhrases, checkEmail, checkShouting, checkGibberish,
];

function runSignals(submission) {
  const fired = [];
  for (const check of SIGNALS) {
    try {
      const result = check(submission);
      if (result) fired.push(result);
    } catch (err) {
      // A broken signal must never stop a submission being accepted. The worst
      // outcome here is a missed spam message; the worst outcome from throwing
      // is a contact form that returns 500.
      console.error('[spam] signal failed:', err.message);
    }
  }
  return fired;
}

module.exports = {
  runSignals, textOf,
  SPAM_PHRASES, DISPOSABLE_DOMAINS,
  checkHoneypot, checkSpeed, checkNoJs, checkLinks,
  checkPhrases, checkEmail, checkShouting, checkGibberish,
};
