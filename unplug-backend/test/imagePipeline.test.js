// The image pipeline, against real encoded bytes — no database needed.
//
// What is pinned here, and why each one is worth a test:
//
//   1. IT ACTUALLY GETS SMALLER. The whole justification for spending CPU on
//      upload is that the result is dramatically lighter. A change that
//      quietly stopped compressing would show up as a slow site months later;
//      it shows up here in a second.
//   2. NOTHING IS UPSCALED. Generating a 1600px derivative of an 800px photo
//      costs bytes and adds nothing.
//   3. METADATA IS STRIPPED, ORIENTATION IS NOT. Those are easy to conflate:
//      the EXIF tag is removed, but the rotation it described must already
//      have been applied, or phone photos come out sideways.
//   4. A FILE THAT IS NOT AN IMAGE IS REFUSED. The declared MIME type comes
//      from the browser; this is the only place the bytes themselves are read.
//   5. THE ORIGINAL IS NEVER TOUCHED.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const {
  buildDerivatives, inspect, assessible, derivativeKey, WIDTHS,
} = require('../src/utils/imagePipeline');

// A photographic-looking source: flat colour compresses to almost nothing in
// any format, which would make the size assertions meaningless.
async function noisyJpeg(width, height) {
  const px = Buffer.alloc(width * height * 3);
  for (let i = 0; i < px.length; i += 3) {
    px[i] = (i * 7) % 255;
    px[i + 1] = (i * 13) % 255;
    px[i + 2] = (i * 29) % 255;
  }
  return sharp(px, { raw: { width, height, channels: 3 } }).jpeg({ quality: 92 }).toBuffer();
}

test('DERIVATIVES ARE DRAMATICALLY SMALLER THAN THE ORIGINAL', async () => {
  // The reason the pipeline exists. A real homepage PNG was 1,911 KB and 49 KB
  // as AVIF at display width; this asserts the shape of that win, not the
  // exact figure, so a codec update cannot fail the suite for improving.
  const png = await sharp({
    create: { width: 2000, height: 1000, channels: 3, background: { r: 90, g: 120, b: 200 } },
  }).png().toBuffer();

  const { derivatives } = await buildDerivatives(png, '123-abc.png');
  assert.ok(derivatives.length > 0, 'something was produced');

  const widest = derivatives
    .filter((d) => d.ext === 'avif')
    .sort((a, b) => b.width - a.width)[0];
  assert.ok(widest.bytes < png.length / 2,
    `the widest AVIF (${widest.bytes}) should be far under the original (${png.length})`);
});

test('AVIF IS SMALLER THAN WEBP AT THE SAME WIDTH', async () => {
  // Both are generated so every browser gets the best it understands. If this
  // ever inverts, generating both has stopped being worth the CPU.
  const src = await noisyJpeg(1200, 600);
  const { derivatives } = await buildDerivatives(src, '1-photo.jpg');
  const at800 = (ext) => derivatives.find((d) => d.width === 800 && d.ext === ext);
  assert.ok(at800('avif').bytes < at800('webp').bytes);
});

test('A SMALL IMAGE IS NEVER UPSCALED', async () => {
  const src = await noisyJpeg(500, 300);
  const { derivatives } = await buildDerivatives(src, '1-small.jpg');
  const widths = [...new Set(derivatives.map((d) => d.width))];
  assert.ok(Math.max(...widths) <= 500, `no derivative wider than the source: got ${widths}`);
  assert.ok(!widths.includes(800), 'the 800 step is skipped entirely');
});

test('an image narrower than the smallest step is still re-encoded', async () => {
  // A 300px PNG avatar is routinely bigger than a 300px AVIF of the same
  // thing, so "too small to resize" must not mean "left alone".
  const src = await sharp({
    create: { width: 300, height: 300, channels: 3, background: { r: 10, g: 200, b: 90 } },
  }).png().toBuffer();
  const { derivatives } = await buildDerivatives(src, '1-avatar.png');
  assert.ok(derivatives.length > 0, 'it still gets AVIF and WebP versions');
  assert.equal(Math.max(...derivatives.map((d) => d.width)), 300);
});

test('EXIF IS STRIPPED BUT THE ROTATION IT DESCRIBED IS APPLIED', async () => {
  // Orientation 6 means "rotate 90° clockwise to display". The tag must go,
  // and the pixels must already be the right way up — dropping the tag without
  // acting on it is how every phone photo ends up sideways.
  const upright = await sharp({
    create: { width: 1000, height: 500, channels: 3, background: { r: 200, g: 30, b: 30 } },
  }).jpeg().toBuffer();
  const tagged = await sharp(upright).withMetadata({ orientation: 6 }).toBuffer();

  const { derivatives } = await buildDerivatives(tagged, '1-phone.jpg');
  const out = derivatives.find((d) => d.ext === 'webp');
  const meta = await sharp(out.buffer).metadata();

  assert.ok(!meta.orientation || meta.orientation === 1, 'the EXIF orientation tag is gone');
  assert.ok(meta.height > meta.width,
    'the landscape source was turned upright, so the output is taller than it is wide');
  assert.equal(meta.exif, undefined, 'no EXIF block survives');
});

test('A FILE THAT IS NOT AN IMAGE IS REFUSED BY READING ITS BYTES', async () => {
  // The upload's MIME allow-list trusts a header the browser supplies. This is
  // the check that looks at the actual container.
  const notAnImage = Buffer.from('%PDF-1.4\n%โฟโฟ\n1 0 obj\n<< /Type /Catalog >>');
  await assert.rejects(() => buildDerivatives(notAnImage, '1-fake.png'),
    'a PDF renamed .png does not become an image');
});

test('an animated image is kept whole rather than frozen', async () => {
  // Resizing one frame and serving it as the picture would silently kill the
  // animation, which is worse than leaving the file alone.
  const meta = { format: 'png', width: 400, height: 400, animated: true };
  const verdict = assessible(meta);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /animated/);
});

test('derivative keys are deterministic, so a URL needs no lookup', async () => {
  assert.equal(derivativeKey('1785-abc.png', 800, 'avif'), 'derivatives/1785-abc-800.avif');
  assert.equal(derivativeKey('1785-abc.jpeg', 400, 'webp'), 'derivatives/1785-abc-400.webp');
  // The same key twice is the same answer twice — the frontend builds these by
  // convention, so drift here would produce srcsets pointing at nothing.
  assert.equal(derivativeKey('x.png', 400, 'webp'), derivativeKey('x.png', 400, 'webp'));
});

test('THE ORIGINAL BUFFER IS NEVER MODIFIED', async () => {
  const src = await noisyJpeg(900, 450);
  const before = Buffer.from(src);
  await buildDerivatives(src, '1-keep.jpg');
  assert.ok(src.equals(before), 'the uploaded bytes are untouched');
});

test('every advertised width is produced in every format', async () => {
  const src = await noisyJpeg(1800, 900);
  const { derivatives } = await buildDerivatives(src, '1-wide.jpg');
  const expected = WIDTHS.filter((w) => w <= 1800);
  for (const ext of ['avif', 'webp']) {
    for (const w of expected) {
      assert.ok(derivatives.some((d) => d.ext === ext && d.width === w),
        `${ext} at ${w}px exists`);
    }
  }
  assert.equal(derivatives.length, expected.length * 2, 'and nothing extra');
});
