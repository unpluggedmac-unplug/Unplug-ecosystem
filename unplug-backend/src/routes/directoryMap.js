const express = require('express');
const pool = require('../db');
const { resolveLocation } = require('../utils/saPlaces');

const router = express.Router();

// Great-circle distance in kilometres. The directory is a few dozen
// listings, so computing this in JS is simpler than a PostGIS dependency and
// fast enough — revisit if the directory grows into the thousands.
function distanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Loads approved listings and resolves each one's position: explicit
// coordinates on the profile if present, otherwise looked up from its town.
// Listings we can't place are returned with coords null, so the caller can
// report honestly how many are missing from the map instead of hiding them.
async function locatedListings(category) {
  const values = [];
  let where = "p.status = 'approved'";
  if (category) {
    values.push(category);
    where += ` AND c.name = $${values.length}`;
  }
  const result = await pool.query(
    `SELECT p.id, p.slug, p.display_name, p.type, p.street_address, p.suburb,
            p.city, p.province, p.country,
            p.latitude, p.longitude, p.deaf_owned_verified, p.verified,
            c.name AS category
       FROM profiles p
       LEFT JOIN categories c ON c.id = p.category_id
      WHERE ${where}
      ORDER BY p.display_name`,
    values
  );
  return result.rows.map((row) => {
    let lat = row.latitude === null ? null : Number(row.latitude);
    let lng = row.longitude === null ? null : Number(row.longitude);
    let approximate = false;
    if (lat === null || lng === null) {
      // Suburb first, then town — so "Sandton" places more precisely than
      // "Johannesburg" when the member gave us a suburb.
      const resolved = resolveLocation({ suburb: row.suburb, city: row.city });
      if (resolved) {
        [lat, lng] = resolved.coords;
        // Flagged so the UI can say "approximate — area centre" rather than
        // implying we know the exact street.
        approximate = true;
      }
    }
    // Privacy: a street address is only ever published for businesses. An
    // individual's is never returned by the API, so it cannot leak to the map
    // even if one somehow got stored.
    const isBusiness = row.type === 'business';
    const streetAddress = isBusiness ? row.street_address : null;
    const locationLabel = [
      streetAddress, row.suburb, row.city, row.province, row.country,
    ].filter(Boolean).join(', ') || null;
    return {
      ...row,
      street_address: streetAddress,
      latitude: lat,
      longitude: lng,
      approximate,
      locationLabel,
    };
  });
}

// GET /directory/map — listings for the map view, optionally by category.
router.get('/map', async (req, res, next) => {
  try {
    const all = await locatedListings((req.query.category || '').trim() || null);
    const placed = all.filter((l) => l.latitude !== null && l.longitude !== null);
    res.json({
      listings: placed,
      total: all.length,
      unplaced: all.length - placed.length,
    });
  } catch (err) {
    next(err);
  }
});

// GET /directory/near?lat=&lng=&radiusKm= — nearest listings first.
router.get('/near', async (req, res, next) => {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: 'A valid location is required.' });
    }
    const radiusKm = Math.min(Number(req.query.radiusKm) || 50, 2000);
    const listings = (await locatedListings((req.query.category || '').trim() || null))
      .filter((l) => l.latitude !== null && l.longitude !== null)
      .map((l) => ({ ...l, distanceKm: Math.round(distanceKm(lat, lng, l.latitude, l.longitude) * 10) / 10 }))
      .filter((l) => l.distanceKm <= radiusKm)
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, 60);
    res.json({ listings, radiusKm });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
