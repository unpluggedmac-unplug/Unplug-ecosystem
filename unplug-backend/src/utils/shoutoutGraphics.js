const sharp = require('sharp');

const BRAND = Object.freeze({
  black: '#050302',
  red: '#df3b01',
  redBright: '#ff2f00',
  ivory: '#e9e2dd',
  ivoryLight: '#f4efe6',
  white: '#ffffff',
});

const BRAND_LINE = 'From the team at Unplug Magazine — Real People. Real Impact.';
const RETURN_LINE = "A new shout-out every day — come back tomorrow to see who's next.";
const WEBSITE = 'www.unplugnews.com';

function lockedMessage(recipientName) {
  return `High-voltage shout-out to ${recipientName}, keep your purpose switched on and let your light spark others.`;
}

function defaultShareCaption(recipientName, shareUrl) {
  return `POWER ON! High-voltage shout-out to ${recipientName}. From Unplug Magazine — Real People. Real Impact. ${shareUrl}`;
}

function escapeXml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function slugPart(value) {
  const slug = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 180);
  return slug || 'unplug-community';
}

function shareSlug(featureDate, recipientName) {
  return `${featureDate}-${slugPart(recipientName)}`;
}

function wrapWords(text, maxChars) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  for (const word of words) {
    if (!current) {
      current = word;
      continue;
    }
    if ((current + ' ' + word).length <= maxChars) current += ' ' + word;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function recipientTypography(name, layout) {
  const len = String(name || '').length;
  const settings = {
    portrait: len <= 18 ? [104, 19] : len <= 28 ? [86, 22] : [70, 25],
    square: len <= 18 ? [86, 19] : len <= 28 ? [72, 22] : [60, 25],
    og: len <= 18 ? [76, 23] : len <= 28 ? [64, 27] : [54, 31],
  }[layout];
  return { fontSize: settings[0], lines: wrapWords(name, settings[1]).slice(0, 3) };
}

function textBlock(lines, x, y, opts = {}) {
  const size = opts.size || 42;
  const lineHeight = opts.lineHeight || Math.round(size * 1.18);
  const weight = opts.weight || 700;
  const fill = opts.fill || BRAND.black;
  const family = opts.family || 'Arial, Helvetica, sans-serif';
  const anchor = opts.anchor || 'start';
  const letterSpacing = opts.letterSpacing || 0;
  return `<text x="${x}" y="${y}" fill="${fill}" font-family="${family}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}" letter-spacing="${letterSpacing}">`
    + lines.map((line, i) => `<tspan x="${x}" dy="${i === 0 ? 0 : lineHeight}">${escapeXml(line)}</tspan>`).join('')
    + '</text>';
}

function mascotSvg(poseKey, x, y, scale = 1) {
  const arm = BRAND.black;
  const bodyX = 18;
  const bodyY = 34;
  const bodyW = 118;
  const bodyH = 142;
  const common = `
    <g transform="translate(${x} ${y}) scale(${scale})" aria-hidden="true">
      <ellipse cx="78" cy="214" rx="70" ry="13" fill="${BRAND.black}" opacity="0.12"/>
      <rect x="${bodyX}" y="${bodyY}" width="${bodyW}" height="${bodyH}" rx="26" fill="${BRAND.black}"/>
      <rect x="40" y="0" width="18" height="48" rx="7" fill="${BRAND.black}"/>
      <rect x="94" y="0" width="18" height="48" rx="7" fill="${BRAND.black}"/>
      <rect x="67" y="10" width="18" height="38" rx="7" fill="${BRAND.red}"/>
      <circle cx="58" cy="91" r="8" fill="${BRAND.ivoryLight}"/>
      <circle cx="99" cy="91" r="8" fill="${BRAND.ivoryLight}"/>
      <path d="M55 125 Q78 147 102 125" fill="none" stroke="${BRAND.ivoryLight}" stroke-width="7" stroke-linecap="round"/>
      <path d="M54 173 L43 208" stroke="${arm}" stroke-width="12" stroke-linecap="round"/>
      <path d="M101 173 L115 208" stroke="${arm}" stroke-width="12" stroke-linecap="round"/>
      <path d="M31 208 L57 208" stroke="${arm}" stroke-width="12" stroke-linecap="round"/>
      <path d="M103 208 L131 208" stroke="${arm}" stroke-width="12" stroke-linecap="round"/>
  `;

  let pose = '';
  if (poseKey === 'megaphone-pointing') {
    pose = `
      <path d="M20 92 L-22 72" stroke="${arm}" stroke-width="11" stroke-linecap="round"/>
      <path d="M-23 71 L-44 58" stroke="${arm}" stroke-width="9" stroke-linecap="round"/>
      <path d="M136 103 L184 88" stroke="${arm}" stroke-width="11" stroke-linecap="round"/>
      <path d="M184 88 L206 87" stroke="${arm}" stroke-width="8" stroke-linecap="round"/>
      <path d="M-62 39 L-20 53 L-20 88 L-62 103 Z" fill="${BRAND.redBright}"/>
      <rect x="-76" y="61" width="18" height="21" rx="5" fill="${BRAND.black}"/>
      <path d="M-84 48 L-103 39 M-84 72 L-109 72 M-84 97 L-103 108" stroke="${BRAND.red}" stroke-width="7" stroke-linecap="round"/>
    `;
  } else if (poseKey === 'spark-wave') {
    pose = `
      <path d="M21 96 Q-4 65 -18 31" stroke="${arm}" stroke-width="11" fill="none" stroke-linecap="round"/>
      <path d="M136 98 Q167 62 173 29" stroke="${arm}" stroke-width="11" fill="none" stroke-linecap="round"/>
      <path d="M173 29 L188 8 M173 29 L199 27 M173 29 L184 50" stroke="${arm}" stroke-width="7" stroke-linecap="round"/>
      <path d="M-29 7 L-16 25 L4 15 L-3 39 L17 49 L-9 52 L-10 78 L-27 58 L-47 70 L-39 45 L-60 35 L-34 31 Z" fill="${BRAND.redBright}"/>
    `;
  } else {
    pose = `
      <path d="M21 100 Q-2 72 -6 38" stroke="${arm}" stroke-width="11" fill="none" stroke-linecap="round"/>
      <path d="M136 100 Q159 72 163 38" stroke="${arm}" stroke-width="11" fill="none" stroke-linecap="round"/>
      <path d="M-6 38 L-16 18 M-6 38 L8 20" stroke="${arm}" stroke-width="7" stroke-linecap="round"/>
      <path d="M163 38 L153 18 M163 38 L177 20" stroke="${arm}" stroke-width="7" stroke-linecap="round"/>
      <path d="M192 2 l8 18 19 8-19 8-8 19-8-19-19-8 19-8z" fill="${BRAND.redBright}"/>
    `;
  }

  return common + pose + '</g>';
}

function backgroundSvg(width, height) {
  return `
    <defs>
      <linearGradient id="redSweep" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${BRAND.redBright}"/>
        <stop offset="1" stop-color="${BRAND.red}"/>
      </linearGradient>
      <pattern id="grain" width="14" height="14" patternUnits="userSpaceOnUse">
        <circle cx="2" cy="4" r="1" fill="${BRAND.black}" opacity="0.05"/>
        <circle cx="10" cy="9" r="0.8" fill="${BRAND.black}" opacity="0.035"/>
      </pattern>
    </defs>
    <rect width="${width}" height="${height}" fill="${BRAND.ivoryLight}"/>
    <rect width="${width}" height="${height}" fill="url(#grain)"/>
    <path d="M0 0 H${Math.round(width * 0.34)} L${Math.round(width * 0.18)} ${height} H0 Z" fill="url(#redSweep)"/>
    <circle cx="${Math.round(width * 0.89)}" cy="${Math.round(height * 0.1)}" r="${Math.round(Math.min(width, height) * 0.14)}" fill="${BRAND.red}" opacity="0.09"/>
    <path d="M${Math.round(width * 0.62)} ${Math.round(height * 0.83)} L${width} ${Math.round(height * 0.68)} L${width} ${height} L${Math.round(width * 0.48)} ${height} Z" fill="${BRAND.black}" opacity="0.055"/>
  `;
}

function portraitSvg(data) {
  const w = 1080; const h = 1350;
  const name = recipientTypography(data.recipientName, 'portrait');
  const messageLines = wrapWords(lockedMessage(data.recipientName), 44).slice(0, 5);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    ${backgroundSvg(w, h)}
    ${mascotSvg(data.mascotPoseKey, 55, 110, 1.55)}
    <rect x="365" y="90" width="635" height="1170" rx="34" fill="${BRAND.ivory}" stroke="${BRAND.black}" stroke-width="4"/>
    <rect x="365" y="90" width="635" height="86" rx="34" fill="${BRAND.black}"/>
    <rect x="365" y="142" width="635" height="34" fill="${BRAND.black}"/>
    ${textBlock(['THE GUY SAYS'], 408, 148, { size: 27, weight: 800, fill: BRAND.ivoryLight, letterSpacing: 3 })}
    ${textBlock(['POWER ON!'], 408, 286, { size: 82, weight: 900, fill: BRAND.redBright })}
    <rect x="408" y="318" width="118" height="10" fill="${BRAND.black}"/>
    ${textBlock(name.lines, 408, 430, { size: name.fontSize, lineHeight: Math.round(name.fontSize * 1.02), weight: 900, fill: BRAND.black })}
    ${textBlock(messageLines, 408, 700, { size: 35, lineHeight: 46, weight: 650, fill: BRAND.black })}
    <line x1="408" y1="955" x2="950" y2="955" stroke="${BRAND.black}" stroke-width="3"/>
    ${textBlock(wrapWords(BRAND_LINE, 43), 408, 1018, { size: 28, lineHeight: 38, weight: 750, fill: BRAND.black })}
    ${textBlock(wrapWords(RETURN_LINE, 46), 408, 1116, { size: 24, lineHeight: 34, weight: 500, fill: BRAND.black })}
    <rect x="408" y="1193" width="542" height="52" rx="26" fill="${BRAND.red}"/>
    ${textBlock([WEBSITE], 679, 1228, { size: 27, weight: 800, fill: BRAND.white, anchor: 'middle', letterSpacing: 1 })}
    ${textBlock(['DAILY', 'SHOUT-OUT'], 68, 535, { size: 58, lineHeight: 66, weight: 900, fill: BRAND.ivoryLight })}
    ${textBlock(['REAL PEOPLE.', 'REAL IMPACT.'], 68, 690, { size: 37, lineHeight: 48, weight: 800, fill: BRAND.ivoryLight })}
  </svg>`;
}

function squareSvg(data) {
  const w = 1080; const h = 1080;
  const name = recipientTypography(data.recipientName, 'square');
  const messageLines = wrapWords(lockedMessage(data.recipientName), 48).slice(0, 5);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    ${backgroundSvg(w, h)}
    ${mascotSvg(data.mascotPoseKey, 42, 102, 1.25)}
    <rect x="305" y="64" width="710" height="952" rx="32" fill="${BRAND.ivory}" stroke="${BRAND.black}" stroke-width="4"/>
    <rect x="305" y="64" width="710" height="76" rx="32" fill="${BRAND.black}"/><rect x="305" y="108" width="710" height="32" fill="${BRAND.black}"/>
    ${textBlock(['THE GUY SAYS'], 348, 116, { size: 24, weight: 800, fill: BRAND.ivoryLight, letterSpacing: 3 })}
    ${textBlock(['POWER ON!'], 348, 224, { size: 70, weight: 900, fill: BRAND.redBright })}
    ${textBlock(name.lines, 348, 335, { size: name.fontSize, lineHeight: Math.round(name.fontSize * 1.02), weight: 900, fill: BRAND.black })}
    ${textBlock(messageLines, 348, 560, { size: 31, lineHeight: 40, weight: 650, fill: BRAND.black })}
    <line x1="348" y1="764" x2="970" y2="764" stroke="${BRAND.black}" stroke-width="3"/>
    ${textBlock(wrapWords(BRAND_LINE, 50), 348, 814, { size: 25, lineHeight: 32, weight: 750, fill: BRAND.black })}
    ${textBlock(wrapWords(RETURN_LINE, 53), 348, 892, { size: 21, lineHeight: 29, weight: 500, fill: BRAND.black })}
    <rect x="348" y="954" width="622" height="44" rx="22" fill="${BRAND.red}"/>
    ${textBlock([WEBSITE], 659, 984, { size: 23, weight: 800, fill: BRAND.white, anchor: 'middle' })}
    ${textBlock(['DAILY', 'SHOUT-OUT'], 52, 475, { size: 47, lineHeight: 55, weight: 900, fill: BRAND.ivoryLight })}
  </svg>`;
}

function ogSvg(data) {
  const w = 1200; const h = 630;
  const name = recipientTypography(data.recipientName, 'og');
  const messageLines = wrapWords(lockedMessage(data.recipientName), 64).slice(0, 3);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    ${backgroundSvg(w, h)}
    ${mascotSvg(data.mascotPoseKey, 50, 115, 1.18)}
    <rect x="300" y="45" width="850" height="540" rx="28" fill="${BRAND.ivory}" stroke="${BRAND.black}" stroke-width="4"/>
    <rect x="300" y="45" width="850" height="64" rx="28" fill="${BRAND.black}"/><rect x="300" y="82" width="850" height="27" fill="${BRAND.black}"/>
    ${textBlock(['THE GUY SAYS'], 338, 88, { size: 22, weight: 800, fill: BRAND.ivoryLight, letterSpacing: 3 })}
    ${textBlock(['POWER ON!'], 338, 174, { size: 58, weight: 900, fill: BRAND.redBright })}
    ${textBlock(name.lines, 338, 258, { size: name.fontSize, lineHeight: Math.round(name.fontSize * 1.0), weight: 900, fill: BRAND.black })}
    ${textBlock(messageLines, 338, 410, { size: 27, lineHeight: 35, weight: 650, fill: BRAND.black })}
    ${textBlock([BRAND_LINE], 338, 525, { size: 20, weight: 750, fill: BRAND.black })}
    <rect x="860" y="541" width="255" height="32" rx="16" fill="${BRAND.red}"/>
    ${textBlock([WEBSITE], 988, 564, { size: 18, weight: 800, fill: BRAND.white, anchor: 'middle' })}
    ${textBlock(['DAILY', 'SHOUT-OUT'], 52, 432, { size: 42, lineHeight: 49, weight: 900, fill: BRAND.ivoryLight })}
  </svg>`;
}

async function renderShoutoutPngs(input) {
  const data = {
    recipientName: String(input.recipientName || '').trim(),
    mascotPoseKey: input.mascotPoseKey || 'power-up',
  };
  if (!data.recipientName) throw new Error('A recipient name is required to render a shout-out.');

  const [portrait, square, og] = await Promise.all([
    sharp(Buffer.from(portraitSvg(data))).png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer(),
    sharp(Buffer.from(squareSvg(data))).png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer(),
    sharp(Buffer.from(ogSvg(data))).png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer(),
  ]);
  return { portrait, square, og };
}

module.exports = {
  BRAND,
  BRAND_LINE,
  RETURN_LINE,
  WEBSITE,
  lockedMessage,
  defaultShareCaption,
  shareSlug,
  renderShoutoutPngs,
};
