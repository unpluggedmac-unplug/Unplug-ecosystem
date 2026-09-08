from pathlib import Path

p = Path('unplug-member-dashboard.html')
s = p.read_text()

old = """    const request = (changes.changeRequests || []).find((r) =>
      r.type === 'article' && Number(r.submissionId) === Number(articleId));
    if (!request) throw new Error('No open change request was found for this article.');"""
new = """    const requests = Array.isArray(changes && changes.changeRequests)
      ? changes.changeRequests
      : (Array.isArray(changes && changes.change_requests) ? changes.change_requests : []);
    const articleRequests = requests.filter((r) =>
      String((r && (r.type || r.submission_type)) || '') === 'article');
    let request = articleRequests.find((r) =>
      Number(r.submissionId != null ? r.submissionId : r.submission_id) === Number(articleId));
    // Defensive fallback for older/newer response shapes: this button only
    // appears on an article already marked changes_requested. If there is one
    // and only one open article request for this member, it is unambiguous.
    if (!request && articleRequests.length === 1) request = articleRequests[0];
    if (!request) throw new Error('No open change request was found for this article.');"""
if old in s:
    s = s.replace(old, new, 1)
elif new not in s:
    raise SystemExit('current change-request matcher not found')

# Keep field handling tolerant too: the API returns [{col,label}] today, while
# an older response shape used plain strings.
old_fields = """    const fields = Array.isArray(request.fields)
      ? request.fields.map((field) => typeof field === 'string' ? field : (field && field.col)).filter(Boolean)
      : [];"""
new_fields = """    const fields = Array.isArray(request.fields)
      ? request.fields.map((field) => typeof field === 'string' ? field : (field && (field.col || field.field))).filter(Boolean)
      : [];"""
if old_fields in s:
    s = s.replace(old_fields, new_fields, 1)
elif new_fields not in s:
    raise SystemExit('current field normalizer not found')

p.write_text(s)
