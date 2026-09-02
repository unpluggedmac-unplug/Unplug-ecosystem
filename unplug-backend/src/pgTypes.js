// A DATE IS A CALENDAR DAY, NOT AN INSTANT.
//
// node-postgres parses a DATE column (type 1082) into a JavaScript Date set to
// MIDNIGHT IN THE SERVER'S OWN TIMEZONE. JSON.stringify then writes that Date
// in UTC. Anywhere east of Greenwich the two disagree about which day it is:
//
//   stored in Postgres   2026-10-31          (a day. no time, no zone.)
//   parsed by pg         2026-10-31 00:00 SAST
//   sent as JSON         "2026-10-30T22:00:00.000Z"
//   read by the page     "2026-10-30"        <-- THE DAY BEFORE
//
// So an event on Saturday is published as Friday, a listing expires a day early,
// and a scheduled article appears a day late — with nothing in the logs, because
// every layer did exactly what it was told.
//
// This has been latent rather than live: Render runs in UTC, where local
// midnight and UTC midnight are the same instant and the two happen to agree.
// It would have become real the moment the server's timezone changed, and it is
// already real on any developer machine outside UTC — which is how it was found.
//
// The fix is to stop converting at all. A DATE has no time and no zone, so
// there is nothing to convert it to; Postgres already sends exactly the text we
// want. Handing that text straight through is both correct and unambiguous in
// every timezone.
//
// This is deliberately global rather than per-query. The alternative — casting
// with to_char in each SELECT — restates the same rule in dozens of places, and
// a rule stated in dozens of places is one that drifts. There are ~29 DATE
// columns across events, highlights, marketplace, scheduling and streaks; this
// covers all of them, and any added later.
//
// NOT affected: TIMESTAMPTZ. That genuinely IS an instant, it round-trips
// correctly, and this file leaves it alone. (There are no bare TIMESTAMP columns
// in this schema, which would have the same problem.)

const { types } = require('pg');

const DATE_OID = 1082;

// Identity: return Postgres's own 'YYYY-MM-DD' text untouched.
types.setTypeParser(DATE_OID, (value) => value);

module.exports = { DATE_OID };
