'use strict';

// Admin-managed pricing for duration-based services.
//
// service_packages is the ONLY source of truth. Batch D deliberately removed
// the old hardcoded fallback: if the pricing table cannot be read, checkout
// must fail closed rather than charge a number that may no longer match what
// the admin configured.
const pool = require('../db');

function pricingUnavailable(message = 'Service pricing is temporarily unavailable.') {
  const err = new Error(message);
  err.code = 'PRICING_UNAVAILABLE';
  err.statusCode = 503;
  return err;
}

// 'article' | 'directory' -> the service_packages key for a highlight.
function highlightServiceKey(targetType) {
  return targetType === 'article' ? 'highlight_article' : 'highlight_directory';
}

// Returns null when the database is healthy but that exact package is not
// currently offered. A database read failure throws instead: there is no safe
// price to guess.
async function priceFor(serviceKey, durationDays) {
  const days = Number(durationDays);
  let r;
  try {
    r = await pool.query(
      `SELECT price FROM service_packages
        WHERE service_key = $1 AND duration_days = $2 AND active = true`,
      [serviceKey, days]
    );
  } catch (err) {
    console.error('service_packages price lookup failed:', err.message);
    throw pricingUnavailable();
  }
  if (r.rowCount === 0) return null;
  return Number(r.rows[0].price);
}

// Every active package for a service, for member-facing pickers. No fallback:
// an unreadable table means the picker must report pricing unavailable instead
// of showing numbers that might be stale.
async function packagesFor(serviceKey) {
  try {
    const r = await pool.query(
      `SELECT duration_days, name, description, price
         FROM service_packages
        WHERE service_key = $1 AND active = true
        ORDER BY display_order, duration_days`,
      [serviceKey]
    );
    return r.rows.map((row) => ({
      durationDays: row.duration_days,
      name: row.name,
      description: row.description,
      price: Number(row.price),
    }));
  } catch (err) {
    console.error('service_packages list failed:', err.message);
    throw pricingUnavailable();
  }
}

module.exports = { priceFor, packagesFor, highlightServiceKey, pricingUnavailable };
