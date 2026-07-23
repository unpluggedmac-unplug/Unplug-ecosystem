# Testing

## Credit-system tests

`test/credit.test.js` verifies the account-credit guarantees against a **real**
PostgreSQL — the double-credit block, concurrent-spend locking, and
transactional rollback are database behaviours that can't be checked by reading
code or with an in-memory fake.

```bash
cd unplug-backend
npm install          # installs devDependencies, incl. embedded-postgres
npm test
```

`embedded-postgres` downloads a real PostgreSQL binary (as a platform-specific
npm package) and runs it on a throwaway port for the test, then tears it down.
Nothing is left running and no system Postgres is needed.

## IMPORTANT — Render deploys must skip dev dependencies

`embedded-postgres` is a **devDependency** and pulls in a large Postgres binary.
Production never needs it (the app never imports it), so Render's build must not
install it. Set **one** of these on the Render service:

- Build command → `npm install --omit=dev`  (recommended), or
- Environment variable → `NODE_ENV=production`

Without this, every deploy still works but downloads the Postgres binary
needlessly, making builds slower and the slug larger. Set it before the next
deploy.
