// ============================================================
// /api/memory-search
// Called by chat.js before sending to Claude.
// Returns relevant memories to inject into the system prompt.
// ============================================================

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { query, limit = 20 } = req.body || {};
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Supabase not configured' });
  }

  try {
    // 1. Always pull pinned memories (high-importance, always-in-context)
    const pinnedRes = await fetch(
      `${SUPABASE_URL}/rest/v1/memories?pinned=eq.true&select=*`,
      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
        },
      }
    );
    const pinned = await pinnedRes.json();

    // 2. Full-text search for query-relevant memories
    let relevant = [];
    if (query && query.trim()) {
      // Postgres full-text search via Supabase
      const searchTerms = query
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2)
        .slice(0, 8)
        .join(' | '); // OR-search across terms

      if (searchTerms) {
        const searchRes = await fetch(
          `${SUPABASE_URL}/rest/v1/memories?content=fts.${encodeURIComponent(searchTerms)}&select=*&limit=${limit}`,
          {
            headers: {
              apikey: SUPABASE_KEY,
              Authorization: `Bearer ${SUPABASE_KEY}`,
            },
          }
        );
        relevant = await searchRes.json();
      }
    }

    // 3. Always pull last 30 days of all memories as fallback context (cheap)
    const recentRes = await fetch(
      `${SUPABASE_URL}/rest/v1/memories?select=*&order=created_at.desc&limit=30`,
      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
        },
      }
    );
    const recent = await recentRes.json();

    // Dedupe by id
    const seen = new Set();
    const all = [...pinned, ...relevant, ...recent].filter(m => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });

    return res.status(200).json({ memories: all });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
