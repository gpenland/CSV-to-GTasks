function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('CSV ↔ Google Tasks');
}

// ---------- Helpers ----------
function parseCsvSmart_(csvText) {
  const rows = Utilities.parseCsv(csvText || '').filter(r => r.join('').trim() !== '');
  if (!rows.length) return { header: null, data: [] };

  const first = rows[0].map(s => (s || '').trim().toLowerCase());
  const looksLikeHeader = first.includes('title');
  const header = looksLikeHeader ? rows[0] : null;
  const data = looksLikeHeader ? rows.slice(1) : rows;
  return { header, data };
}

function normalizeDueInput_(raw) {
  if (!raw) return null;
  const s = ('' + raw).trim();
  // Accept YYYY-MM-DD or RFC3339
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    // Normalize to midnight UTC so comparisons are stable
    return new Date(s + 'T00:00:00Z').toISOString();
  }
  // If it's a Date-parsable RFC3339-ish value, normalize to ISO
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString();
  return null; // unknown format
}

function isoDateOnly_(iso) {
  if (!iso) return null;
  try {
    return new Date(iso).toISOString().slice(0, 10); // YYYY-MM-DD
  } catch (e) {
    return null;
  }
}

// Returns array of {id,title,notes,due} for ALL tasks in list (active + completed + hidden)
function listAllTasks_(listId) {
  const out = [];
  let pageToken;
  do {
    const resp = Tasks.Tasks.list(listId, {
      showCompleted: true,
      showHidden: true,
      maxResults: 100,
      pageToken
    });
    (resp.items || []).forEach(t => {
      out.push({
        id: t.id,
        title: (t.title || '').trim(),
        notes: (t.notes || '').trim(),
        due: t.due || null
      });
    });
    pageToken = resp.nextPageToken;
  } while (pageToken);
  return out;
}

// ---------- API: Lists ----------
function getTaskLists() {
  const res = Tasks.Tasklists.list();
  return (res.items || []).map(l => ({ id: l.id, title: l.title }));
}

// ---------- API: Import ----------
/**
 * CSV columns (header optional): title, notes, due
 * - due accepts YYYY-MM-DD or RFC3339
 */
function addTasksFromCsv(csvText, tasklistId) {
  const listId = tasklistId || 'default';
  const { data } = parseCsvSmart_(csvText);
  if (!data.length) return { created: 0, ids: [] };

  const createdIds = [];
  data.forEach(cols => {
    const [t, n, d] = cols;
    const title = (t || '').trim();
    if (!title) return;

    const task = { title };
    const notes = (n || '').trim();
    if (notes) task.notes = notes;

    const dueIso = normalizeDueInput_(d);
    if (dueIso) task.due = dueIso;

    const created = Tasks.Tasks.insert(task, listId);
    if (created && created.id) createdIds.push(created.id);
  });

  return { created: createdIds.length, ids: createdIds };
}

// ---------- API: Undo-by-CSV (delete every instance that matches each CSV row) ----------
/**
 * For each CSV row, delete ALL tasks that match the provided fields:
 * - title: REQUIRED to match
 * - notes: if provided (non-empty), must match exactly (trimmed)
 * - due: if provided:
 *    - if input was YYYY-MM-DD → compare by date-only
 *    - if input was RFC3339   → compare exact normalized ISO
 */
function deleteTasksFromCsv(csvText, tasklistId) {
  const listId = tasklistId || 'default';
  const { data } = parseCsvSmart_(csvText);
  if (!data.length) return { deleted: 0, details: [] };

  const all = listAllTasks_(listId);
  let deleteCount = 0;
  const details = [];

  data.forEach(cols => {
    const [t, n, d] = cols;
    const title = (t || '').trim();
    const notes = (n || '').trim();
    const dueRaw = (d || '').trim();

    if (!title) {
      details.push({ row: cols, deleted: 0, reason: 'Missing title' });
      return;
    }

    // Determine matching rule for due
    const normalized = normalizeDueInput_(dueRaw);
    const dueMode = dueRaw
      ? (/^\d{4}-\d{2}-\d{2}$/.test(dueRaw) ? 'date-only' : (normalized ? 'exact' : 'invalid'))
      : 'none';

    // Collect matches
    const matches = all.filter(task => {
      if (task._deleted) return false; // skip already deleted this run
      if ((task.title || '').trim() !== title) return false;

      if (notes) {
        if ((task.notes || '').trim() !== notes) return false;
      }

      if (dueMode === 'date-only') {
        if (!task.due) return false;
        return isoDateOnly_(task.due) === dueRaw;
      } else if (dueMode === 'exact') {
        if (!task.due) return false;
        return task.due === normalized;
      } else if (dueMode === 'invalid') {
        // If provided but unparsable, never match due
        return false;
      }
      // dueMode === 'none' → ignore due
      return true;
    });

    let rowDeleted = 0;
    matches.forEach(m => {
      try {
        Tasks.Tasks.delete(listId, m.id);
        m._deleted = true; // mark in local cache so we don't delete twice
        deleteCount++;
        rowDeleted++;
      } catch (err) {
        // skip failures
      }
    });

    details.push({ row: cols, deleted: rowDeleted });
  });

  return { deleted: deleteCount, details };
}
