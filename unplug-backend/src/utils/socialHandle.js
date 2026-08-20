// Reading a social handle out of whatever a person types into one box.
//
// The nominate form asks for "@theirhandle or a link to their page", so this
// has to cope with a full URL pasted off a phone, a bare @handle, and a
// half-remembered "instagram.com/thandi" with no scheme.
//
// It returns two things and never throws:
//
//   text  what they typed, tidied but not rewritten. This is what the desk
//         reads. Keeping it verbatim matters — if we cannot turn it into a
//         link, the raw text is the only clue anyone has.
//   url   a safe https:// link, ONLY when one can honestly be built. A bare
//         handle returns null rather than a guess: "@thandi" exists on four
//         platforms and sending an editor to the wrong person's page is
//         worse than sending them nowhere.
//
// SAFETY. The URL is rendered as a clickable link on the admin screen, so it
// must never be anything but http(s). javascript:, data: and the rest are
// dropped — a link an admin clicks is a link that runs somewhere.

const MAX_LENGTH = 200;

// Hosts we recognise well enough to add a scheme to. Anything else that
// already carries http(s):// is still accepted; this list only decides what
// counts as a link when the person left the scheme off.
const KNOWN_HOSTS = [
  'facebook.com', 'fb.com', 'm.facebook.com',
  'instagram.com', 'tiktok.com',
  'twitter.com', 'x.com',
  'linkedin.com', 'youtube.com', 'youtu.be',
  'threads.net', 'threads.com',
];

function parseSocialHandle(raw) {
  const text = String(raw == null ? '' : raw).trim().slice(0, MAX_LENGTH);
  if (!text) return { text: null, url: null };

  // Already a URL. Accept http(s) only, and normalise http to https so the
  // desk is not sent over a plain connection.
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) {
    const scheme = text.slice(0, text.indexOf(':')).toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') {
      // javascript:, data:, mailto: and friends. Keep the text so the desk can
      // see what was submitted, but never offer it as something to click.
      return { text, url: null };
    }
    let url;
    try {
      url = new URL(text);
    } catch (e) {
      return { text, url: null };
    }
    url.protocol = 'https:';
    return { text, url: url.href.slice(0, 300) };
  }

  // No scheme. Only treat it as a link if it looks like one of the hosts we
  // know — otherwise "Thandi from Soweto" would become a website.
  const withoutWww = text.replace(/^www\./i, '');
  const host = withoutWww.split(/[/?#]/)[0].toLowerCase();
  if (KNOWN_HOSTS.includes(host)) {
    try {
      const url = new URL('https://' + withoutWww);
      return { text, url: url.href.slice(0, 300) };
    } catch (e) {
      return { text, url: null };
    }
  }

  // A bare handle, a name, or something we do not recognise. Kept as text.
  return { text, url: null };
}

module.exports = { parseSocialHandle, MAX_LENGTH, KNOWN_HOSTS };
