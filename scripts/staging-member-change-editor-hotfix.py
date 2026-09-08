from pathlib import Path

p = Path('unplug-member-dashboard.html')
s = p.read_text()

# The member change-request API intentionally returns the public member shape:
#   { type, submissionId, fields: [{ col, label }, ...] }
# The first staging UI patch accidentally looked for the admin/database names
# submission_type/submission_id and treated fields as strings. Correct the UI
# to consume the route's real contract.
old_match = """    const request = (changes.changeRequests || []).find((r) =>\n      r.submission_type === 'article' && Number(r.submission_id) === Number(articleId));"""
new_match = """    const request = (changes.changeRequests || []).find((r) =>\n      r.type === 'article' && Number(r.submissionId) === Number(articleId));"""
if old_match in s:
    s = s.replace(old_match, new_match)
elif new_match not in s:
    raise SystemExit('change-request matcher not found')

old_fields = "    const fields = Array.isArray(request.fields) ? request.fields : [];"
new_fields = """    const fields = Array.isArray(request.fields)\n      ? request.fields.map((field) => typeof field === 'string' ? field : (field && field.col)).filter(Boolean)\n      : [];"""
if old_fields in s:
    s = s.replace(old_fields, new_fields)
elif new_fields not in s:
    raise SystemExit('change-request field normalizer not found')

# A previous staging hotfix could render the same edit action twice. Mark the
# action on the row and suppress any second copy defensively.
old_cond = "if (s.type === 'article' && s.status === 'changes_requested') {"
new_cond = "if (s.type === 'article' && s.status === 'changes_requested' && !row.querySelector('[data-ms-change-edit]')) {"
if old_cond in s:
    s = s.replace(old_cond, new_cond)

old_type = "    editBtn.type = 'button';\n    editBtn.className = 'btn btn-line';"
new_type = "    editBtn.type = 'button';\n    editBtn.setAttribute('data-ms-change-edit', '1');\n    editBtn.className = 'btn btn-line';"
if old_type in s:
    s = s.replace(old_type, new_type)

p.write_text(s)
