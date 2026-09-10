# Unplug Control Centre — Phase 13
## Security headers + CSP repair

Phase 13 fixes the frontend CSP/security-header architecture before staging.

### What changed

1. **One authoritative CSP**
   - Removed CSP from `_headers`.
   - Removed the six `http-equiv=Content-Security-Policy` meta tags.
   - Added `functions/_middleware.js`, which runs in front of the whole Cloudflare Pages application and adds the policy once.

2. **Environment-aware `connect-src`**
   - Production permits the configured production API (or the existing production Render API fallback).
   - Staging/preview permits only an explicitly configured non-production `UNPLUG_API`.
   - Removed the old `https://*.onrender.com` wildcard.
   - A misconfigured staging environment receives no production API permission.

3. **Fixed missing CSP sources**
   - Instagram embed script and frames.
   - YouTube IFrame API and frames.
   - SoundCloud frames.
   - Explicit service-worker/manifest sources.
   - Supabase/R2/media image origins.

4. **Reduced inline-script exposure**
   - Production build already extracts executable inline `<script>` blocks into hashed `/assets/*.js` files.
   - `script-src-elem` is now strict and does not allow `'unsafe-inline'`.
   - Only `script-src-attr` temporarily allows `'unsafe-inline'` because legacy HTML still contains inline `onclick`/`onchange` handlers.
   - Report-Only policy sets `script-src-attr 'none'` so those remaining handlers can be measured before removal.

5. **Security headers retained/strengthened**
   - HSTS
   - X-Content-Type-Options
   - X-Frame-Options
   - Referrer-Policy
   - Permissions-Policy
   - Cross-Origin-Opener-Policy
   - object-src 'none'
   - frame-ancestors 'none'
   - base-uri 'self'
   - form-action 'self'

6. **Media origin support**
   - Optional Cloudflare Pages variable: `UNPLUG_MEDIA_ORIGINS`
   - Comma-separated HTTPS origins if a custom R2/media domain is used.

### Verification

Run:

```bash
npm run security:check
```

The checker verifies that no duplicate CSP remains, `*.onrender.com` is gone, staging fails closed, known embeds are allowed, and critical hardening directives remain.

Dependency-light commercial/readiness tests also continue to pass: 8/8.

### Remaining hardening step

The one significant CSP concession is `script-src-attr 'unsafe-inline'`, required by legacy inline event attributes. The next security-refactor task should convert those attributes to delegated/addEventListener handlers. Once that is complete, change enforced `script-src-attr` to `'none'`.
