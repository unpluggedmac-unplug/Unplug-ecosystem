// Admin-managed pricing for the duration-based services.
//
// Prices live in the service_packages table so an admin can change them without
// a deploy. The hardcoded tables below are the FALLBACK, not the source of
// truth: if a row is missing (or the lookup fails) the server charges the
// original known price rather than throwing or, far worse, charging zero.
//
// Everything that quotes or charges these services goes through priceFor(), so
// the quote a member is shown and the amount they're charged always come from
// the same place.
const pool = require('../db');

// Last-known-good prices, matching what migration 065 seeds.
const FALLBACK_PRICES = {
  highlight_article: { 7: 150.00, 14: 250.00, 21: 300.00, 28: 450.00 },
  highlight_directory: { 7: 100.00, 14: 150.00, 21: 200.00, 28: 250.00 },
  ad_banner: { 7: 300.00, 14: 550.00, 28: 1000.00 },
};

// 'article' | 'directory' -> the service_packages key for a highlight.
function highlightServiceKey(targetType) {
  return targetType === 'article' ? 'highlight_article' : 'highlight_directory';
}

// The price to charge for one package. Returns null when the combination isn't
// a real package at all (bad duration), so callers can reject it clearly rather
// than defaulting to something arbitrary.
async function priceFor(serviceKey, durationDays) {
  const days = Number(durationDays);
  try {
    const r = await pool.query(
      `SELECT price FROM service_packages
        WHERE service_key = $1 AND duration_days = $2 AND active = true`,
      [serviceKey, days]
    );
    if (r.rowCount > 0) return Number(r.rows[0].price);
  } catch (err) {
    // A pricing table that's unreadable must not take checkout down; fall
    // through to the known-good constant and log it loudly.
    console.error('service_packages lookup failed, using fallback price:', err.message);
  }
  const table = FALLBACK_PRICES[serviceKey];
  if (!table) return null;
  return table[days] === undefined ? null : table[days];
}

// Every active package for a service, for the member-facing picker. Falls back
// to the constants so the picker still renders if the table is unavailable.
async function packagesFor(serviceKey) {
  try {
    const r = await pool.query(
      `SELECT duration_days, name, description, price
         FROM service_packages
        WHERE service_key = $1 AND active = true
        ORDER BY display_order, duration_days`,
      [serviceKey]
    );
    if (r.rowCount > 0) {
      return r.rows.map((row) => ({
        durationDays: row.duration_days,
        name: row.name,
        description: row.description,
        price: Number(row.price),
      }));
    }
  } catch (err) {
    console.error('service_packages list failed, using fallback prices:', err.message);
  }
  const table = FALLBACK_PRICES[serviceKey] || {};
  return Object.keys(table).map(Number).sort((a, b) => a - b).map((d) => ({
    durationDays: d,
    name: `${d}-Day Package`,
    description: null,
    price: table[d],
  }));
}

module.exports = { priceFor, packagesFor, highlightServiceKey, FALLBACK_PRICES };
