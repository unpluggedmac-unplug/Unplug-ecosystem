// Reading what a file actually is, rather than what it says it is.
//
// The hole this closes: every upload was accepted on `file.mimetype`, which
// multer takes from the Content-Type the BROWSER supplied. Anyone could post
// anything and label it "image/png". Since uploads land in a PUBLIC bucket and
// the URL is handed out, the file that gets stored is the file that gets
// served — so an HTML document accepted as an image is stored XSS on our own
// storage domain, and an SVG is a scriptable document, not a picture.
//
// No database needed: this is bytes in, verdict out.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const sharp = require('sharp');
const { detect, verify } = require('../src/utils/fileSignature');

const IMAGES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-sig-'));

function writeTemp(name, buffer) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, buffer);
  return p;
}

test('REAL IMAGES ARE RECOGNISED BY THEIR BYTES', async () => {
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#123456' } }).png().toBuffer();
  const jpg = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#123456' } }).jpeg().toBuffer();
  const webp = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#123456' } }).webp().toBuffer();

  assert.equal(detect(png), 'image/png');
  assert.equal(detect(jpg), 'image/jpeg');
  assert.equal(detect(webp), 'image/webp');
});

test('AN HTML FILE RENAMED .png IS REFUSED', async () => {
  // The one that matters most. Uploads go to a public bucket and the link is
  // handed out, so an HTML file accepted here is a script running on our own
  // storage domain, for anyone who opens it.
  const p = writeTemp('evil.png', Buffer.from('<html><script>alert(document.cookie)</script></html>'));
  const result = verify(p, IMAGES);
  assert.equal(result.ok, false);
  assert.equal(result.detected, null);
  assert.match(result.reason, /not one we can read/i);
});

test('AN SVG IS REFUSED — it is a scriptable document, not a picture', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
  const p = writeTemp('sneaky.png', Buffer.from(svg));
  assert.equal(verify(p, IMAGES).ok, false);
});

test('A PDF RENAMED .png IS REFUSED, AND SAID SO PLAINLY', async () => {
  const p = writeTemp('doc.png', Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n'));
  const result = verify(p, IMAGES);
  assert.equal(result.ok, false);
  assert.equal(result.detected, 'application/pdf', 'it identifies what the file really is');
  assert.match(result.reason, /PDF/, 'and tells the uploader, who is usually not an attacker');
});

test('a real PDF is accepted where PDFs belong', async () => {
  const p = writeTemp('edition.pdf', Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n1 0 obj\n'));
  const result = verify(p, ['application/pdf']);
  assert.equal(result.ok, true);
  assert.equal(result.detected, 'application/pdf');
});

test('AN IMAGE IS REFUSED WHERE ONLY A PDF BELONGS', async () => {
  // The check runs in both directions: the edition uploader must not accept a
  // screenshot just because a screenshot is a legitimate file somewhere else.
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } }).png().toBuffer();
  const p = writeTemp('notanedition.pdf', png);
  const result = verify(p, ['application/pdf']);
  assert.equal(result.ok, false);
  assert.equal(result.detected, 'image/png');
});

test('A REJECTED FILE IS DELETED FROM DISK', async () => {
  // A refused upload that stays on the server is still a file an attacker
  // managed to place there. Verified through the middleware, which owns the
  // deletion, rather than through the detector.
  const { verifySignature } = require('../src/middleware/upload');
  const p = writeTemp('todelete.png', Buffer.from('<html>not an image</html>'));
  assert.ok(fs.existsSync(p), 'it exists before the check');

  const result = verifySignature({ path: p, mimetype: 'image/png' }, IMAGES);
  assert.equal(result.ok, false);

  // The unlink is asynchronous and best-effort; give the event loop a turn.
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fs.existsSync(p), false, 'and is gone afterwards');
});

test('a valid file is left exactly where it is', async () => {
  const { verifySignature } = require('../src/middleware/upload');
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#0a0' } }).png().toBuffer();
  const p = writeTemp('good.png', png);

  const result = verifySignature({ path: p, mimetype: 'image/png' }, IMAGES);
  assert.equal(result.ok, true);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(fs.existsSync(p), 'a genuine upload is not touched');
});

test('an empty or truncated file is refused rather than guessed at', async () => {
  assert.equal(detect(Buffer.alloc(0)), null);
  assert.equal(detect(Buffer.from([0xFF, 0xD8])), null, 'two bytes is not enough to be sure');
});

test('a WAV file is not mistaken for a WEBP', async () => {
  // Both start "RIFF". Checking only the container would accept audio as an
  // image, which is exactly the kind of near-miss a short signature list gets
  // wrong.
  const wav = Buffer.concat([
    Buffer.from('RIFF'), Buffer.from([0x24, 0x00, 0x00, 0x00]), Buffer.from('WAVE'),
    Buffer.alloc(20),
  ]);
  assert.equal(detect(wav), null);
});

test('the missing-file case is handled without throwing', async () => {
  const { verifySignature } = require('../src/middleware/upload');
  assert.equal(verifySignature(null, IMAGES).ok, false);
  assert.equal(verify(path.join(dir, 'does-not-exist.png'), IMAGES).ok, false);
});
