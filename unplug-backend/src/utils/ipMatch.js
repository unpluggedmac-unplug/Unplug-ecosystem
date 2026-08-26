// Does this address fall inside that range?
//
// Written by hand rather than pulled in: the whole job is a prefix comparison
// on bits, the rules have not changed since 1993, and a dependency that
// decides who gets blocked from a live site is a dependency that can decide
// wrong after an update nobody read.
//
// THE FAILURE MODE THAT MATTERS. Every uncertain answer here is NO. A malformed
// range, an address that will not parse, a v4 address tested against a v6
// range — all return false, which means "this rule does not match" and the
// request continues. The alternative, failing closed, means a typo in a CIDR
// silently blocks real readers, and the person who could fix it is the one
// locked out.

// "41.2.3.4" -> 690492164, or null when it is not a v4 address.
function ipv4ToInt(ip) {
  const parts = String(ip).trim().split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    // Rejects "0x1f", "01", "" and "999" alike. Leading zeros matter: some
    // parsers read "010" as octal, and an address that means two different
    // things to two parsers is how a block gets bypassed.
    if (!/^\d{1,3}$/.test(part)) return null;
    const v = Number(part);
    if (v > 255) return null;
    if (part.length > 1 && part[0] === '0') return null;
    n = (n * 256) + v;
  }
  return n;
}

// An IPv6 address as an array of eight 16-bit groups, or null.
function ipv6ToGroups(ip) {
  let s = String(ip).trim().toLowerCase();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);

  // "::ffff:41.2.3.4" — a v4 address wearing a v6 coat. Unwrapped so a v4
  // rule matches a v4 client that happened to arrive on a dual-stack socket.
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) {
    const v4 = ipv4ToInt(mapped[1]);
    if (v4 === null) return null;
    return [0, 0, 0, 0, 0, 0xffff, (v4 >>> 16) & 0xffff, v4 & 0xffff];
  }

  const halves = s.split('::');
  if (halves.length > 2) return null; // "::" may appear once

  const parse = (part) => (part ? part.split(':').map((g) => {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return NaN;
    return parseInt(g, 16);
  }) : []);

  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  if ([...head, ...tail].some(Number.isNaN)) return null;

  if (halves.length === 1) return head.length === 8 ? head : null;

  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  return [...head, ...new Array(missing).fill(0), ...tail];
}

// Is `ip` inside `cidr`? Both families supported; a mismatch is simply false.
function inCidr(ip, cidr) {
  const text = String(cidr || '').trim();
  const slash = text.lastIndexOf('/');
  if (slash === -1) return false;

  const network = text.slice(0, slash);
  const bits = Number(text.slice(slash + 1));
  if (!Number.isInteger(bits) || bits < 0) return false;

  // --- IPv4 ---------------------------------------------------------------
  const netV4 = ipv4ToInt(network);
  if (netV4 !== null) {
    if (bits > 32) return false;
    const addr = ipv4ToInt(String(ip).replace(/^::ffff:/i, ''));
    if (addr === null) return false;
    if (bits === 0) return true; // 0.0.0.0/0 is everything, and says so
    // >>> not >>: a 32-bit mask with the high bit set is negative under the
    // signed shift, and every comparison after it is wrong.
    const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
    return ((addr >>> 0) & mask) === ((netV4 >>> 0) & mask);
  }

  // --- IPv6 ---------------------------------------------------------------
  const netV6 = ipv6ToGroups(network);
  if (!netV6) return false;
  if (bits > 128) return false;
  const addrV6 = ipv6ToGroups(ip);
  if (!addrV6) return false;

  let remaining = bits;
  for (let i = 0; i < 8 && remaining > 0; i++) {
    const take = Math.min(16, remaining);
    const mask = take === 16 ? 0xffff : (0xffff << (16 - take)) & 0xffff;
    if ((addrV6[i] & mask) !== (netV6[i] & mask)) return false;
    remaining -= take;
  }
  return true;
}

// Two addresses written differently can be the same address: "::ffff:1.2.3.4"
// and "1.2.3.4", or "2001:0db8::1" and "2001:db8::1". Compared by value rather
// than by string so a block cannot be walked around by changing the notation.
function sameAddress(a, b) {
  const sa = String(a || '').trim();
  const sb = String(b || '').trim();
  if (!sa || !sb) return false;
  if (sa.toLowerCase() === sb.toLowerCase()) return true;

  const a4 = ipv4ToInt(sa.replace(/^::ffff:/i, ''));
  const b4 = ipv4ToInt(sb.replace(/^::ffff:/i, ''));
  if (a4 !== null && b4 !== null) return a4 === b4;

  const a6 = ipv6ToGroups(sa);
  const b6 = ipv6ToGroups(sb);
  if (a6 && b6) return a6.every((g, i) => g === b6[i]);
  return false;
}

// Is this something that could sensibly be stored as a rule? Used to refuse a
// bad rule at the point somebody types it, rather than storing a rule that
// silently never matches.
function isValidIp(value) {
  const s = String(value || '').replace(/^::ffff:/i, '');
  return ipv4ToInt(s) !== null || ipv6ToGroups(String(value)) !== null;
}

function isValidCidr(value) {
  const text = String(value || '').trim();
  const slash = text.lastIndexOf('/');
  if (slash === -1) return false;
  const network = text.slice(0, slash);
  const bits = Number(text.slice(slash + 1));
  if (!Number.isInteger(bits) || bits < 0) return false;
  if (ipv4ToInt(network) !== null) return bits <= 32;
  if (ipv6ToGroups(network)) return bits <= 128;
  return false;
}

module.exports = { inCidr, sameAddress, isValidIp, isValidCidr, ipv4ToInt, ipv6ToGroups };
