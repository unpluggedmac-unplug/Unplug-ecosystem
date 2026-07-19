// Coordinates for South African cities and towns, so a listing that only has
// a town name still appears on the map. This is deliberately a small local
// lookup rather than a geocoding API: no key to manage, no per-request cost,
// no third party seeing our members' addresses. A listing with real
// latitude/longitude on the profile always wins over this table.
const PLACES = {
  'johannesburg': [-26.2041, 28.0473],
  'sandton': [-26.1076, 28.0567],
  'soweto': [-26.2678, 27.8585],
  'pretoria': [-25.7479, 28.2293],
  'centurion': [-25.8603, 28.1894],
  'midrand': [-25.9992, 28.1263],
  'benoni': [-26.1885, 28.3208],
  'boksburg': [-26.2125, 28.2624],
  'kempton park': [-26.1000, 28.2333],
  'krugersdorp': [-26.1000, 27.7667],
  'vereeniging': [-26.6731, 27.9261],
  'vanderbijlpark': [-26.6992, 27.8377],
  'cape town': [-33.9249, 18.4241],
  'stellenbosch': [-33.9321, 18.8602],
  'paarl': [-33.7342, 18.9621],
  'somerset west': [-34.0847, 18.8500],
  'bellville': [-33.9000, 18.6333],
  'george': [-33.9630, 22.4617],
  'knysna': [-34.0363, 23.0471],
  'mossel bay': [-34.1831, 22.1461],
  'oudtshoorn': [-33.5906, 22.2014],
  'hermanus': [-34.4187, 19.2345],
  'worcester': [-33.6465, 19.4485],
  'durban': [-29.8587, 31.0218],
  'pietermaritzburg': [-29.6006, 30.3794],
  'umhlanga': [-29.7261, 31.0857],
  'ballito': [-29.5387, 31.2144],
  'richards bay': [-28.7807, 32.0383],
  'newcastle': [-27.7580, 29.9317],
  'port elizabeth': [-33.9608, 25.6022],
  'gqeberha': [-33.9608, 25.6022],
  'east london': [-33.0153, 27.9116],
  'mthatha': [-31.5889, 28.7844],
  'grahamstown': [-33.3049, 26.5328],
  'makhanda': [-33.3049, 26.5328],
  'bloemfontein': [-29.0852, 26.1596],
  'welkom': [-27.9770, 26.7350],
  'kimberley': [-28.7282, 24.7499],
  'upington': [-28.4478, 21.2561],
  'polokwane': [-23.9045, 29.4689],
  'tzaneen': [-23.8333, 30.1667],
  'thohoyandou': [-22.9500, 30.4833],
  'nelspruit': [-25.4753, 30.9694],
  'mbombela': [-25.4753, 30.9694],
  'witbank': [-25.8722, 29.2333],
  'emalahleni': [-25.8722, 29.2333],
  'rustenburg': [-25.6545, 27.2559],
  'potchefstroom': [-26.7167, 27.1000],
  'mahikeng': [-25.8653, 25.6442],
  'klerksdorp': [-26.8521, 26.6667],
};

// Normalises "  Cape  Town " / "CAPE TOWN" to the lookup key form.
function normalise(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Returns [lat, lng] for a town name, or null when we don't know it — the
// caller then simply leaves that listing off the map rather than guessing.
function coordsForPlace(name) {
  const key = normalise(name);
  if (!key) return null;
  if (PLACES[key]) return PLACES[key];
  // Tolerate "Cape Town, Western Cape" and similar by trying the first part.
  const first = normalise(key.split(',')[0]);
  return PLACES[first] || null;
}

module.exports = { coordsForPlace, PLACES };
