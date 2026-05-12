// ============================================================
// /api/memory-list — read/manage memories, with auth
// ============================================================

import crypto from 'node:crypto';

function verifyAuth(req) {
  const APP_SECRET = process.env.APP_SECRET;
  if (!APP_SECRET) return false;
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payload, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', APP_SECRET).update(payload).digest('base64url');
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expectedSig);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!verifyAuth(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

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
    if (req.method === 'GET') {
      const [memRes, pendRes] = await Promise.all([
        fetch(`${SUPABASE_URL}/rest/v1/memories?select=*&order=pinned.desc,created_at.desc`, { headers: sbHeaders }),
        fetch(`${SUPABASE_URL}/rest/v1/pending_memories?select=*&order=created_at.desc`, { headers: sbHeaders }),
      ]);
      const memories = await memRes.json();
      const pending = await pendRes.json();
      return res.status(200).json({ memories, pending });
    }

    const { action, id } = req.body || {};
    if (!action || !id) return res.status(400).json({ error: 'action and id required' });

    if (action === 'confirm') {
      const getRes = await fetch(`${SUPABASE_URL}/rest/v1/pending_memories?id=eq.${id}&select=*`, { headers: sbHeaders });
      const [pending] = await getRes.json();
      if (!pending) return res.status(404).json({ error: 'pending memory not found' });
      const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/memories`, {
        method: 'POST',
        headers: { ...sbHeaders, Prefer: 'return=representation' },
        body: JSON.stringify({ category: pending.category, content: pending.content, context: pending.context }),
      });
      const saved = await insertRes.json();
      await fetch(`${SUPABASE_URL}/rest/v1/pending_memories?id=eq.${id}`, { method: 'DELETE', headers: sbHeaders });
      return res.status(200).json({ ok: true, saved: saved[0] });
    }

    if (action === 'reject') {
      await fetch(`${SUPABASE_URL}/rest/v1/pending_memories?id=eq.${id}`, { method: 'DELETE', headers: sbHeaders });
      return res.status(200).json({ ok: true });
    }

    if (action === 'delete') {
      await fetch(`${SUPABASE_URL}/rest/v1/memories?id=eq.${id}`, { method: 'DELETE', headers: sbHeaders });
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
        method: 'PATCH', headers: sbHeaders,
        body: JSON.stringify({ pinned: !!pinned }),
      });
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: `unknown action: ${action}` });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
