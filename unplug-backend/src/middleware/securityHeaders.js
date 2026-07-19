// Baseline security response headers. Written by hand rather than pulling in
// helmet: this API serves JSON and a couple of text files, so only a handful
// of headers actually apply, and a dependency-free version is one less thing
// to keep patched.
function securityHeaders(req, res, next) {
  // Stop browsers guessing a different content type to the one we declare —
  // the classic way a JSON or upload response gets treated as HTML/script.
  res.set('X-Content-Type-Options', 'nosniff');

  // This API has no UI of its own, so nothing here should ever be framed.
  res.set('X-Frame-Options', 'DENY');

  // Don't leak the full API URL (which can contain ids) to third-party sites.
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');

  // No reason for API responses to request camera/mic/location.
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

  // Tell browsers to stick to HTTPS. Render terminates TLS for us, so this is
  // only meaningful in production — setting it on a local http:// dev server
  // would make the machine refuse plain http to localhost.
  if (req.secure || req.get('x-forwarded-proto') === 'https') {
    res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  next();
}

module.exports = securityHeaders;
