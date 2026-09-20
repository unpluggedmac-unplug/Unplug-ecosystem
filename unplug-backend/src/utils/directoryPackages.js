'use strict';

const pool = require('../db');

const PROFILE_TYPES = Object.freeze(['individual', 'business']);
const TIERS = Object.freeze(['basic', 'pro', 'premium']);

function pricingUnavailable(message = 'Directory pricing is temporarily unavailable.') {
  const err = new Error(message);
  err.code = 'PRICING_UNAVAILABLE';
  err.statusCode = 503;
  return err;
}

function validateIdentity(profileType, tier) {
  if (!PROFILE_TYPES.includes(profileType) || !TIERS.includes(tier)) {
    const err = new Error('Invalid Directory package.');
    err.code = 'INVALID_DIRECTORY_PACKAGE';
    err.statusCode = 400;
    throw err;
  }
}

async function priceForDirectoryPackage(profileType, tier, client = pool) {
  validateIdentity(profileType, tier);
  let result;
  try {
    result = await client.query(
      `SELECT price
         FROM directory_package_prices
        WHERE profile_type = $1 AND tier = $2 AND active = true`,
      [profileType, tier]
    );
  } catch (err) {
    console.error('directory package price lookup failed:', err.message);
    throw pricingUnavailable();
  }
  if (result.rowCount !== 1) {
    const err = new Error('That Directory package is not currently available.');
    err.code = 'PACKAGE_UNAVAILABLE';
    err.statusCode = 400;
    throw err;
  }
  return Number(result.rows[0].price);
}

async function directoryPackages({ includeInactive = false } = {}, client = pool) {
  try {
    const result = await client.query(
      `SELECT p.id, p.profile_type, p.tier, p.price, p.active, p.display_order,
              p.updated_at, u.email AS updated_by_email
         FROM directory_package_prices p
         LEFT JOIN users u ON u.id = p.updated_by
        ${includeInactive ? '' : 'WHERE p.active = true'}
        ORDER BY CASE p.profile_type WHEN 'individual' THEN 1 ELSE 2 END,
                 p.display_order,
                 CASE p.tier WHEN 'basic' THEN 1 WHEN 'pro' THEN 2 ELSE 3 END`
    );
    return result.rows.map((row) => ({
      ...row,
      price: Number(row.price),
    }));
  } catch (err) {
    console.error('directory package list failed:', err.message);
    throw pricingUnavailable();
  }
}

function asPriceMap(rows) {
  const map = { individual: {}, business: {} };
  for (const row of rows || []) {
    if (map[row.profile_type]) map[row.profile_type][row.tier] = Number(row.price);
  }
  return map;
}

module.exports = {
  PROFILE_TYPES,
  TIERS,
  pricingUnavailable,
  priceForDirectoryPackage,
  directoryPackages,
  asPriceMap,
};
