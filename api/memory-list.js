// ============================================================
// /api/memory-list
// Multi-purpose endpoint for the memories page.
// Methods:
//   GET                  → list all memories (+ pending)
//   POST  { action:'confirm', id }     → move pending → memories
//   POST  { action:'reject',  id }     → delete from pending
//   POST  { action:'update',  id, ...} → edit a memory
//   POST  { action:'delete',  id }     → delete a memory
//   POST  { action:'pin',     id, pinned } → toggle pin
// ============================================================

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Supabase not configured' });
  }

  const sbHeaders = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
  };

  try {
    // ── GET: list everything ──────────────────────────
    if (req.method === 'GET') {
      const [memRes, pendRes] = await Promise.all([
        fetch(`${SUPABASE_URL}/rest/v1/memories?select=*&order=pinned.desc,created_at.desc`, {
          headers: sbHeaders,
        }),
        fetch(`${SUPABASE_URL}/rest/v1/pending_memories?select=*&order=created_at.desc`, {
          headers: sbHeaders,
        }),
      ]);
      const memories = await memRes.json();
      const pending = await pendRes.json();
      return res.status(200).json({ memories, pending });
    }

    // ── POST: actions ─────────────────────────────────
    const { action, id } = req.body || {};
    if (!action || !id) {
      return res.status(400).json({ error: 'action and id required' });
    }

    if (action === 'confirm') {
      // Get pending → insert into memories → delete from pending
      const getRes = await fetch(
        `${SUPABASE_URL}/rest/v1/pending_memories?id=eq.${id}&select=*`,
        { headers: sbHeaders }
      );
      const [pending] = await getRes.json();
      if (!pending) return res.status(404).json({ error: 'pending memory not found' });

      const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/memories`, {
        method: 'POST',
        headers: { ...sbHeaders, Prefer: 'return=representation' },
        body: JSON.stringify({
          category: pending.category,
          content: pending.content,
          context: pending.context,
        }),
      });
      const saved = await insertRes.json();

      await fetch(`${SUPABASE_URL}/rest/v1/pending_memories?id=eq.${id}`, {
        method: 'DELETE',
        headers: sbHeaders,
      });

      return res.status(200).json({ ok: true, saved: saved[0] });
    }

    if (action === 'reject') {
      await fetch(`${SUPABASE_URL}/rest/v1/pending_memories?id=eq.${id}`, {
        method: 'DELETE',
        headers: sbHeaders,
      });
      return res.status(200).json({ ok: true });
    }

    if (action === 'delete') {
      await fetch(`${SUPABASE_URL}/rest/v1/memories?id=eq.${id}`, {
        method: 'DELETE',
        headers: sbHeaders,
      });
      return res.status(200).json({ ok: true });
    }

    if (action === 'update') {
      const { category, content, context } = req.body;
      const patch = {};
      if (category !== undefined) patch.category = category;
      if (content !== undefined) patch.content = content;
      if (context !== undefined) patch.context = context;
      patch.updated_at = new Date().toISOString();

      const r = await fetch(`${SUPABASE_URL}/rest/v1/memories?id=eq.${id}`, {
        method: 'PATCH',
        headers: { ...sbHeaders, Prefer: 'return=representation' },
        body: JSON.stringify(patch),
      });
      const updated = await r.json();
      return res.status(200).json({ ok: true, updated: updated[0] });
    }

    if (action === 'pin') {
      const { pinned } = req.body;
      await fetch(`${SUPABASE_URL}/rest/v1/memories?id=eq.${id}`, {
        method: 'PATCH',
        headers: sbHeaders,
        body: JSON.stringify({ pinned: !!pinned }),
      });
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: `unknown action: ${action}` });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
