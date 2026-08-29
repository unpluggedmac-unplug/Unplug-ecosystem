// HOW A REFERENCE IS MADE. One copy.
//
// A reference is the string that ties a submission to its payment to its
// approval to its invoice (spec §15). It gets read off a screen, written onto
// a bank transfer, and typed back in by a human, so how it is generated is a
// customer-facing decision rather than an implementation detail.
//
// This file exists because that decision had been made five separate times:
// orders.js, editionAccess.js, competitions.js, payments.js and admin.js each
// wrote out their own alphabet and their own collision-retry loop. Four copies
// of the same 32-character string, and two of the five had quietly drifted to
// Math.random(). This codebase's recurring bug is a value stated twice, and
// this was that bug with four copies.
//
// WHAT THIS FILE DOES NOT DO: it does not unify the FORMATS. Those genuinely
// differ, and for reasons that are still true — see the note at the bottom.
// Consolidating how a code is generated is not the same as changing what
// customers already have written down.

const crypto = require('crypto');
const pool = require('../db');

// O/0 and I/1 are indistinguishable in many fonts. A customer mistyping their
// own reference is a support problem, so those four characters are out. What
// is left is 32 symbols, which at ten characters is about 2^50 combinations —
// the uniqueness guarantee is the database's unique index, this just makes a
// collision something that never actually happens.
const REFERENCE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const REFERENCE_LENGTH = 10;

// crypto.randomInt, never Math.random.
//
// Math.random is seeded and predictable, and two of the five call sites this
// replaces were using it. For an order reference that mostly costs nothing;
// for a voucher code it means somebody who works out the seed can generate
// valid discount codes. There is no reason to have both, so there is one.
function randomCode(length = REFERENCE_LENGTH) {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += REFERENCE_ALPHABET[crypto.randomInt(REFERENCE_ALPHABET.length)];
  }
  return out;
}

// A numeric reference with no leading zero — some gateways and some bank
// reference fields accept digits only.
function randomDigits(length = REFERENCE_LENGTH) {
  let out = String(crypto.randomInt(1, 10));
  for (let i = 1; i < length; i++) out += String(crypto.randomInt(0, 10));
  return out;
}

// Generate a code that is not already in use.
//
// `table` and `column` are CONSTANTS WRITTEN AT THE CALL SITE and never come
// from a request, which is what makes interpolating them here safe — the same
// rule adminCovers.js follows for its descriptor. A caller that passed a
// request value would be the bug, so the shape below makes that obvious.
//
// `client` lets a caller run inside its own transaction; it defaults to the
// pool, so a caller with nothing to coordinate need not care.
async function generateUnique({
  table, column, prefix = '', length = REFERENCE_LENGTH, digits = false, client = pool,
}) {
  if (!/^[a-z_]+$/.test(table) || !/^[a-z_]+$/.test(column)) {
    throw new Error('generateUnique: table and column must be plain identifiers');
  }
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = prefix + (digits ? randomDigits(length) : randomCode(length));
    const existing = await client.query(
      `SELECT 1 FROM ${table} WHERE ${column} = $1 LIMIT 1`, [candidate]
    );
    if (existing.rowCount === 0) return candidate;
  }
  // Eight failures against a 2^50 space means something other than bad luck —
  // a broken random source, or the wrong column being checked. Throwing beats
  // returning a duplicate into a column with a unique index.
  throw new Error(`Could not generate a unique value for ${table}.${column}.`);
}

module.exports = { REFERENCE_ALPHABET, REFERENCE_LENGTH, randomCode, randomDigits, generateUnique };

// ---------------------------------------------------------------------------
// THE FORMATS, AND WHY THEY ARE NOT ALL THE SAME
// ---------------------------------------------------------------------------
//
//   orders.reference               UNP- + 10   the order/submission reference
//   edition_purchases.download_ref 10          typed back in to claim a download
//   vote_bundles.reference         10          or the contestant's entry code
//   payments.gateway_reference     10 digits   numeric-only field
//   vouchers.code                  UNP- + 6    a discount code, not a reference
//
// These are not five spellings of one idea:
//
//   * vote_bundles.reference and edition_purchases.download_reference are
//     VARCHAR(10). A UNP- prefix does not fit, and widening a column that live
//     rows already use is a migration, not a tidy-up.
//   * The vote bundle reference IS the contestant's public entry code by
//     deliberate design (migration 106). It is not random and must not be.
//   * A voucher code is not a reference at all. It shares the UNP- prefix,
//     which is worth revisiting, because a customer looking at UNP-K3M9XQ and
//     UNP-K3M9XQ2R7T cannot tell which one their bank transfer needs.
//
// Spec §15 says the format is admin-configurable and its UNP-2026-000001 is an
// example rather than a requirement. The live non-sequential format is what we
// keep: a sequential reference tells every customer how many orders have ever
// been taken, and two invoices a month apart reveal the rate.
