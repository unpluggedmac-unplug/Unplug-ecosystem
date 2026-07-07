// Shared ?page=/?limit= parsing for list endpoints. Keeps every route's
// pagination behavior (defaults, caps, response shape) consistent instead of
// each route inventing its own.

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function getPagination(req, { defaultLimit = DEFAULT_LIMIT, maxLimit = MAX_LIMIT } = {}) {
  let page = parseInt(req.query.page, 10);
  let limit = parseInt(req.query.limit, 10);
  if (!Number.isInteger(page) || page < 1) page = 1;
  if (!Number.isInteger(limit) || limit < 1) limit = defaultLimit;
  limit = Math.min(limit, maxLimit);
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

function paginationMeta(page, limit, total) {
  return { page, limit, total, totalPages: Math.max(Math.ceil(total / limit), 1) };
}

module.exports = { getPagination, paginationMeta };
