from pathlib import Path

path = Path('unplug-backend/src/routes/admin.js')
text = path.read_text()

import_old = "const { getStaffAccess } = require('../utils/staffPermissions');\n"
import_new = import_old + "const { notifyMemberAsync } = require('../utils/memberNotify');\n"
if import_old not in text:
    raise SystemExit('staffPermissions import anchor not found; refusing to patch')
if "require('../utils/memberNotify')" not in text:
    text = text.replace(import_old, import_new, 1)

old = """    await logActivity(req.user.id, 'article_approved',
      `Article #${req.params.id} — ${result.rows[0].title}${scheduledFor ? ` (scheduled ${scheduledFor})` : ''}`);
    res.json({ article: result.rows[0] });
"""
new = """    await logActivity(req.user.id, 'article_approved',
      `Article #${req.params.id} — ${result.rows[0].title}${scheduledFor ? ` (scheduled ${scheduledFor})` : ''}`);

    // Approval is a transactional status change the member must be told about.
    // Fire-and-forget after the database update + activity log so an email
    // provider problem can never roll back or delay the approval itself.
    const approvedArticle = result.rows[0];
    notifyMemberAsync({
      userId: approvedArticle.author_user_id,
      type: 'submission_approved',
      isStatusChange: true,
      title: scheduledFor ? '✅ Your article has been approved and scheduled' : '✅ Your article has been approved',
      body: scheduledFor
        ? `“${approvedArticle.title}” has been approved and is scheduled for publication on ${scheduledFor}.`
        : `“${approvedArticle.title}” has been approved and published on Unplug Magazine.`,
      linkUrl: scheduledFor ? '/unplug-member-dashboard' : `/unplug-magazine.html?p=article&id=${approvedArticle.id}`,
      email: {
        subject: scheduledFor ? 'Your Unplug article has been approved and scheduled' : 'Your Unplug article has been approved',
        text: scheduledFor
          ? `Your article “${approvedArticle.title}” has been approved and is scheduled for publication on ${scheduledFor}.`
          : `Your article “${approvedArticle.title}” has been approved and published on Unplug Magazine.`,
      },
    });

    res.json({ article: approvedArticle });
"""
if old not in text:
    raise SystemExit('article approval tail anchor not found; refusing to patch')
if text.count(old) != 1:
    raise SystemExit(f'expected one article approval tail, found {text.count(old)}')
path.write_text(text.replace(old, new, 1))

test = Path('unplug-backend/test/articleApprovalNotification.test.js')
test.write_text("""const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const adminPath = path.join(__dirname, '..', 'src', 'routes', 'admin.js');
const src = fs.readFileSync(adminPath, 'utf8');

test('article approval notifies the owning member after approval is logged', () => {
  assert.match(src, /const \\{ notifyMemberAsync \\} = require\\('\\.\\.\\/utils\\/memberNotify'\\);/);
  const routeAt = src.indexOf(\"router.patch('/articles/:id/approve'\");
  const logAt = src.indexOf(\"await logActivity(req.user.id, 'article_approved'\", routeAt);
  const notifyAt = src.indexOf('notifyMemberAsync({', logAt);
  const responseAt = src.indexOf('res.json({ article: approvedArticle });', notifyAt);
  assert.ok(routeAt >= 0 && logAt > routeAt && notifyAt > logAt && responseAt > notifyAt,
    'notification must be after approval logging and before the response');
});

test('article approval notification is status-aware and links published articles', () => {
  const routeAt = src.indexOf(\"router.patch('/articles/:id/approve'\");
  const tail = src.slice(routeAt, routeAt + 3500);
  assert.match(tail, /type: 'submission_approved'/);
  assert.match(tail, /isStatusChange: true/);
  assert.match(tail, /approvedArticle\\.author_user_id/);
  assert.match(tail, /unplug-magazine\\.html\\?p=article&id=/);
  assert.match(tail, /approved and is scheduled for publication/);
  assert.match(tail, /approved and published on Unplug Magazine/);
});
""")
print('Patch and contract test created.')
