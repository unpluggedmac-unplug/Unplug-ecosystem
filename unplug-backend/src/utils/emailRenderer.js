// Turning composed blocks into an email that survives the clients people use.
//
// WHY THIS IS HAND-WRITTEN RATHER THAN MJML.
//
// MJML was the obvious candidate and I installed it to find out what it costs
// instead of guessing: 227 packages, 197 top-level directories, 47 MB in
// node_modules. This instance has 512 MB of RAM in total and already runs the
// whole magazine in it. Six block types is not worth a tenth of the memory
// budget and a dependency tree that size on the security-patch treadmill —
// the same reasoning that gave this codebase a hand-written SigV4 signer
// rather than the AWS SDK, and hand-written security headers rather than
// helmet.
//
// WHAT THAT COSTS, stated plainly: MJML's real value is that it has absorbed
// years of Outlook bug reports. Outlook on Windows renders with Word, which
// ignores padding on <div>, ignores max-width, and ignores background-image.
// This file works around the ones that matter — tables for layout, VML for
// buttons, explicit widths everywhere — but it has not been through what MJML
// has been through. If Outlook rendering turns out to be a real problem for
// this audience, swapping this module for MJML is a contained change: the
// blocks are stored as JSON and rendered at send time, so a different renderer
// improves every future send rather than only new drafts.
//
// THE RULES THE LAYOUT FOLLOWS, each one for a client that breaks otherwise:
//
//   TABLES, NOT DIVS. Word's rendering engine has no flexbox, no grid, and
//   no reliable padding on block elements. A table cell has padding it obeys.
//
//   EVERY STYLE INLINE. Gmail strips <style> from the document entirely when
//   a message is forwarded, and Yahoo strips most of it always. The <style>
//   block here holds only the mobile media query, which is a progressive
//   improvement — if it is stripped, the fixed 600px layout still reads.
//
//   NO REMOTE CSS, NO WEB FONTS, NO JAVASCRIPT. None of them work, and a web
//   font that fails leaves the fallback anyway, so the fallback is the choice.
//
//   600px. Not a design preference: it is what Outlook's reading pane fits
//   without a horizontal scrollbar.
//
// EVERY PIECE OF TEXT IS ESCAPED and every URL is parsed before it is written
// into the document. The blocks are typed by an admin, but an admin pasting a
// title with an ampersand in it should not silently break the message, and a
// stored campaign is exactly the kind of thing a compromised admin session
// would use to put a link somewhere unexpected.

// The brand, as literal hex.
//
// THIS IS A SECOND COPY of what unplug-tokens.css holds, and that is a thing
// this codebase has been bitten by before. It is deliberate and unavoidable:
// an email cannot load a stylesheet and no mail client supports CSS custom
// properties, so the values have to be literals in the document. Kept in one
// object rather than scattered through the file, so a rebrand is one edit
// here plus one in unplug-tokens.css rather than forty.
const BRAND = {
  ink: '#272626',
  slate: '#454545',
  black: '#0f0e0e',
  cream: '#ffffff',
  paper: '#f1f0ef',
  line: '#e0dedd',      // token uses rgba(); mail clients want an opaque hex
  red: '#d20709',
  maroon: '#721415',
  body: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, Helvetica, sans-serif",
  display: "Georgia, 'Times New Roman', Times, serif",
};

const WIDTH = 600;

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// A URL is written into the document only if it parses AND is a scheme a
// reader can safely follow. Everything else becomes nothing, and the caller
// renders the block without a link rather than with a broken one.
//
// javascript: is inert in every modern mail client, but "inert in every client
// I know of" is not a security argument — some clients render mail in a real
// browser context, and a campaign is stored data an attacker with an admin
// session could choose.
function safeUrl(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

// Turns the light markup an admin can type in a text block into HTML. A
// deliberately tiny set — bold, italic, links, line breaks — applied AFTER
// escaping, so the escaping cannot be worked around by typing markup.
function inlineFormat(text) {
  let out = escapeHtml(text);
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s.,!?)])/g, '$1<em>$2</em>');
  // [label](url) — the URL is re-checked here because it arrived as text.
  out = out.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (match, label, href) => {
    const url = safeUrl(href.replace(/&amp;/g, '&'));
    if (!url) return label;
    return `<a href="${escapeHtml(url)}" style="color:${BRAND.red}; text-decoration:underline;">${label}</a>`;
  });
  return out.replace(/\n/g, '<br>');
}

// A row: one table, one cell, so padding is honoured everywhere.
function row(inner, { padding = '0 32px', background = BRAND.cream, align = 'left' } = {}) {
  return `<tr><td align="${align}" style="padding:${padding}; background-color:${background};">${inner}</td></tr>`;
}

// ---------------------------------------------------------------------------
// The blocks
// ---------------------------------------------------------------------------
//
// Each returns { html, text }. The plain-text half is NOT an afterthought: a
// message with no text part is scored as spam by most filters, and some people
// read mail as text on purpose.

const BLOCKS = {
  heading(block) {
    const level = [1, 2, 3].includes(Number(block.level)) ? Number(block.level) : 2;
    const size = { 1: 30, 2: 24, 3: 19 }[level];
    const content = escapeHtml(block.text || '');
    if (!content) return null;
    return {
      html: row(
        `<h${level} style="margin:0; font-family:${BRAND.display}; font-size:${size}px;`
        + ` line-height:1.25; font-weight:700; color:${BRAND.black};`
        // Word ignores line-height on headings without this.
        + ` mso-line-height-rule:exactly; text-align:${block.align === 'center' ? 'center' : 'left'};">`
        + `${content}</h${level}>`,
        { padding: '24px 32px 8px' }),
      text: `\n${block.text}\n${'='.repeat(Math.min(60, String(block.text).length))}\n`,
    };
  },

  text(block) {
    const content = String(block.text || '').trim();
    if (!content) return null;
    return {
      html: row(
        `<div style="margin:0; font-family:${BRAND.body}; font-size:16px; line-height:1.65;`
        + ` mso-line-height-rule:exactly; color:${BRAND.ink};`
        + ` text-align:${block.align === 'center' ? 'center' : 'left'};">`
        + `${inlineFormat(content)}</div>`,
        { padding: '8px 32px 16px' }),
      // The markup is stripped rather than left in, so the text part reads as
      // prose instead of as source.
      text: content
        .replace(/\*\*([^*\n]+)\*\*/g, '$1')
        .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, '$1 ($2)') + '\n',
    };
  },

  image(block) {
    const src = safeUrl(block.src);
    if (!src) return null;
    // alt is REQUIRED in spirit and defaulted to empty rather than to a
    // filename. Roughly half of readers see images blocked by default, and an
    // empty alt on a decorative image is correct where "IMG_4471.jpg" never is.
    const alt = escapeHtml(block.alt || '');
    const href = safeUrl(block.href);
    const img = `<img src="${escapeHtml(src)}" alt="${alt}" width="${WIDTH - 64}"`
      + ` style="display:block; width:100%; max-width:${WIDTH - 64}px; height:auto;`
      + ` border:0; outline:none; text-decoration:none;" class="u-fluid">`;
    return {
      html: row(href ? `<a href="${escapeHtml(href)}">${img}</a>` : img, { padding: '8px 32px 16px' }),
      text: (block.alt ? `[image: ${block.alt}]` : '[image]') + (href ? `\n${href}` : '') + '\n',
    };
  },

  button(block) {
    const href = safeUrl(block.href);
    const label = String(block.label || '').trim();
    // A button with nowhere to go is not rendered at all. Rendering a dead
    // button is worse than rendering nothing: somebody presses it.
    if (!href || !label) return null;

    const bg = block.style === 'outline' ? BRAND.cream : BRAND.red;
    const fg = block.style === 'outline' ? BRAND.red : BRAND.cream;

    // VML for Outlook on Windows, which draws no rounded corners, no padding
    // and no background on an <a>. The width has to be a fixed number because
    // VML cannot size to its content — estimated from the label, which is
    // approximate on purpose: too wide reads as a button, too narrow clips.
    const vmlWidth = Math.max(160, Math.min(360, label.length * 10 + 56));

    return {
      html: row(
        `<!--[if mso]>`
        + `<v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word"`
        + ` href="${escapeHtml(href)}" style="height:46px; v-text-anchor:middle; width:${vmlWidth}px;"`
        + ` arcsize="13%" strokecolor="${BRAND.red}" fillcolor="${bg}">`
        + `<w:anchorlock/><center style="color:${fg}; font-family:Arial,sans-serif; font-size:16px; font-weight:bold;">`
        + `${escapeHtml(label)}</center></v:roundrect><![endif]-->`
        + `<!--[if !mso]><!-- -->`
        + `<a href="${escapeHtml(href)}" style="display:inline-block; background-color:${bg};`
        + ` color:${fg}; font-family:${BRAND.body}; font-size:16px; font-weight:700;`
        + ` line-height:46px; text-align:center; text-decoration:none; border-radius:6px;`
        + ` border:2px solid ${BRAND.red}; padding:0 28px; mso-hide:all;">`
        + `${escapeHtml(label)}</a>`
        + `<!--<![endif]-->`,
        { padding: '8px 32px 24px', align: block.align === 'left' ? 'left' : 'center' }),
      text: `\n${label}: ${href}\n`,
    };
  },

  divider() {
    return {
      html: row(
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>`
        // A 1px table cell rather than <hr>, which Outlook draws at its own
        // thickness in its own colour.
        + `<td style="height:1px; line-height:1px; font-size:0; background-color:${BRAND.line};">&nbsp;</td>`
        + `</tr></table>`,
        { padding: '8px 32px' }),
      text: '\n---\n',
    };
  },

  spacer(block) {
    const height = Math.max(4, Math.min(96, Number(block.height) || 24));
    return {
      html: row(
        `<div style="height:${height}px; line-height:${height}px; font-size:0;">&nbsp;</div>`,
        { padding: '0 32px' }),
      text: '\n',
    };
  },

  // A card for one of the magazine's own articles. The composer fills the
  // fields from the database when the block is added, and they are STORED on
  // the block rather than looked up at send time — a campaign should say what
  // it said when it was written, not change because somebody edited the
  // headline afterwards.
  article(block) {
    const href = safeUrl(block.href);
    const title = escapeHtml(block.title || '');
    if (!title) return null;
    const image = safeUrl(block.image);
    const excerpt = escapeHtml(String(block.excerpt || '').slice(0, 240));

    const titleHtml = href
      ? `<a href="${escapeHtml(href)}" style="color:${BRAND.black}; text-decoration:none;">${title}</a>`
      : title;

    return {
      html: row(
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"`
        + ` style="border:1px solid ${BRAND.line}; border-radius:8px;">`
        + (image
          ? `<tr><td style="padding:0;"><img src="${escapeHtml(image)}" alt="" width="${WIDTH - 66}"`
            + ` style="display:block; width:100%; max-width:${WIDTH - 66}px; height:auto; border:0;`
            + ` border-radius:8px 8px 0 0;" class="u-fluid"></td></tr>`
          : '')
        + `<tr><td style="padding:18px 20px;">`
        + `<div style="font-family:${BRAND.display}; font-size:19px; line-height:1.3; font-weight:700;`
        + ` color:${BRAND.black}; mso-line-height-rule:exactly;">${titleHtml}</div>`
        + (excerpt
          ? `<div style="font-family:${BRAND.body}; font-size:14px; line-height:1.6; color:${BRAND.slate};`
            + ` padding-top:8px; mso-line-height-rule:exactly;">${excerpt}</div>`
          : '')
        + (href
          ? `<div style="padding-top:12px;"><a href="${escapeHtml(href)}"`
            + ` style="font-family:${BRAND.body}; font-size:14px; font-weight:700; color:${BRAND.red};`
            + ` text-decoration:none;">Read it &rarr;</a></div>`
          : '')
        + `</td></tr></table>`,
        { padding: '8px 32px 16px' }),
      text: `\n${block.title}\n${block.excerpt || ''}\n${href || ''}\n`,
    };
  },
};

const BLOCK_TYPES = Object.keys(BLOCKS);

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

function render({ subject = '', preheader = '', blocks = [] } = {}) {
  const parts = [];
  for (const block of Array.isArray(blocks) ? blocks : []) {
    const builder = BLOCKS[block && block.type];
    // An unknown block type is SKIPPED, not rendered as an error and not
    // thrown on. A campaign saved by a newer version of the composer must
    // still send the blocks this version understands rather than failing
    // entirely — a send that goes out missing one block is recoverable, a
    // send that does not go out at all is not.
    if (!builder) continue;
    const built = builder(block);
    if (built) parts.push(built);
  }

  const body = parts.map((p) => p.html).join('\n');
  const text = parts.map((p) => p.text).join('\n').replace(/\n{3,}/g, '\n\n').trim();

  // The preheader: the grey line of text a client shows after the subject. Not
  // hiding it means the first words of the message get used, which is usually
  // "View this in your browser". The trailing run of zero-width spaces stops
  // the client pulling the body's opening words in after it.
  const preheaderHtml = preheader
    ? `<div style="display:none; font-size:1px; line-height:1px; max-height:0; max-width:0;`
      + ` opacity:0; overflow:hidden; mso-hide:all;">${escapeHtml(preheader)}`
      + '&#847;&zwnj;&nbsp;'.repeat(30) + '</div>'
    : '';

  const html = `<!doctype html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(subject)}</title>
<!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->
<style>
  /* The ONLY stylesheet, and everything in it is optional. Gmail drops this
     block on forward and Yahoo drops most of it always, so nothing here may
     be load-bearing — the inline styles above are the real layout. */
  @media only screen and (max-width:620px) {
    .u-wrap { width:100% !important; }
    .u-fluid { width:100% !important; height:auto !important; }
    .u-pad { padding-left:20px !important; padding-right:20px !important; }
  }
</style>
</head>
<body style="margin:0; padding:0; background-color:${BRAND.paper};">
${preheaderHtml}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
       style="background-color:${BRAND.paper};">
  <tr><td align="center" style="padding:24px 12px;">
    <table role="presentation" class="u-wrap" width="${WIDTH}" cellpadding="0" cellspacing="0" border="0"
           style="width:${WIDTH}px; max-width:${WIDTH}px; background-color:${BRAND.cream}; border-radius:10px;">
      <tr><td align="center" style="padding:24px 32px 8px; background-color:${BRAND.black}; border-radius:10px 10px 0 0;">
        <div style="font-family:${BRAND.display}; font-size:22px; font-weight:700; letter-spacing:0.02em;
                    color:${BRAND.cream}; padding-bottom:16px;">Unplug<span style="color:${BRAND.red};">.</span></div>
      </td></tr>
${body}
      <tr><td style="height:8px; line-height:8px; font-size:0; background-color:${BRAND.cream};
                     border-radius:0 0 10px 10px;">&nbsp;</td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;

  return { html, text };
}

module.exports = { render, BLOCK_TYPES, BRAND, escapeHtml, safeUrl, inlineFormat, WIDTH };
