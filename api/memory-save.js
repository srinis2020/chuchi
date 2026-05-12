// ============================================================
// /api/memory-save
// Saves a new memory (auto-save) OR queues it for confirmation (pending).
// Body: { category, content, context?, confidence?, pending?: boolean, reason? }
// ============================================================

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Supabase not configured' });
  }

  const {
    category = 'other',
    content,
    context = null,
    confidence = 'high',
    pending = false,
    reason = null,
  } = req.body || {};

  if (!content || !content.trim()) {
    return res.status(400).json({ error: 'content is required' });
  }

  // Sanitize category
  const validCats = ['person', 'business', 'preference', 'decision', 'other'];
  const cat = validCats.includes(category) ? category : 'other';

  const table = pending ? 'pending_memories' : 'memories';
  const payload = pending
    ? { category: cat, content, context, reason }
    : { category: cat, content, context, confidence };

  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        Prefer: 'return=representation',
      },
      body: JSON.stringify(payload),
    });

    const data = await r.json();
    if (!r.ok) {
      return res.status(r.status).json({ error: data.message || 'Save failed', detail: data });
    }
    return res.status(200).json({ saved: data[0], pending });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
