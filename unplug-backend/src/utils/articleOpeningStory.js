const MAX_MEMBER_OPENING_STORY_CHARS = 300;

function validateMemberOpeningStory(user, body) {
  if (body === undefined || body === null) return null;
  if (user && user.role === 'admin') return null;

  const length = String(body).length;
  if (length <= MAX_MEMBER_OPENING_STORY_CHARS) return null;

  return `Opening Story must be ${MAX_MEMBER_OPENING_STORY_CHARS} characters or fewer. Use article sections to continue the full article.`;
}

module.exports = {
  MAX_MEMBER_OPENING_STORY_CHARS,
  validateMemberOpeningStory,
};
