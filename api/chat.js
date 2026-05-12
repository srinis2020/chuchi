// ============================================================
// /api/chat — Chuchi's brain, with memory
// ============================================================
// Flow:
//  1. Receive { model, max_tokens, system, messages } from browser
//  2. Pull relevant memories from Supabase based on latest user message
//  3. Inject memories into the system prompt
//  4. Call Anthropic
//  5. Return response to browser
//  6. (async, fire-and-forget) Extract any new memories from the exchange
// ============================================================

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const API_KEY = process.env.ANTHROPIC_API_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;

  if (!API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY missing' });

  const body = req.body || {};
  const messages = body.messages || [];
  const originalSystem = body.system || '';

  try {
    // ─── 1. Fetch relevant memories ────────────────────
    let memoryBlock = '';
    if (SUPABASE_URL && SUPABASE_KEY) {
      const latestUserMsg = [...messages].reverse().find(m => m.role === 'user')?.content || '';
      const memories = await fetchMemories(latestUserMsg, SUPABASE_URL, SUPABASE_KEY);
      if (memories.length > 0) {
        memoryBlock = formatMemories(memories);
      }
    }

    // ─── 2. Build augmented system prompt ──────────────
    const systemWithMemory = memoryBlock
      ? `${originalSystem}\n\n${memoryBlock}`
      : originalSystem;

    // ─── 3. Call Anthropic ─────────────────────────────
    const anthropicRes = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: body.model || 'claude-sonnet-4-20250514',
        max_tokens: body.max_tokens || 1000,
        system: systemWithMemory,
        messages,
      }),
    });
    const data = await anthropicRes.json();

    // ─── 4. Return response to browser immediately ─────
    res.status(anthropicRes.status).json(data);

    // ─── 5. Fire-and-forget: extract memories ──────────
    // Runs after response is sent, doesn't block the user.
    if (anthropicRes.ok && SUPABASE_URL && SUPABASE_KEY && data.content) {
      const assistantReply = data.content[0]?.text || '';
      const userMsg = [...messages].reverse().find(m => m.role === 'user')?.content || '';
      // Don't await — let it run in background
      extractMemories(userMsg, assistantReply, API_KEY, SUPABASE_URL, SUPABASE_KEY).catch(
        err => console.error('Memory extraction failed:', err)
      );
    }
  } catch (error) {
    if (!res.headersSent) {
      return res.status(500).json({ error: error.message });
    }
  }
}

// ────────────────────────────────────────────────────────
// HELPERS
// ────────────────────────────────────────────────────────

async function fetchMemories(query, SUPABASE_URL, SUPABASE_KEY) {
  const sbHeaders = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
  };

  // Pinned memories — always included
  const pinnedP = fetch(
    `${SUPABASE_URL}/rest/v1/memories?pinned=eq.true&select=*`,
    { headers: sbHeaders }
  ).then(r => r.json()).catch(() => []);

  // Recent memories — last 30 to provide ambient context
  const recentP = fetch(
    `${SUPABASE_URL}/rest/v1/memories?select=*&order=created_at.desc&limit=30`,
    { headers: sbHeaders }
  ).then(r => r.json()).catch(() => []);

  // Keyword search on the latest user message
  let searchP = Promise.resolve([]);
  if (query && query.trim()) {
    const terms = query
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2)
      .slice(0, 8)
      .join(' | ');
    if (terms) {
      searchP = fetch(
        `${SUPABASE_URL}/rest/v1/memories?content=fts.${encodeURIComponent(terms)}&select=*&limit=15`,
        { headers: sbHeaders }
      ).then(r => r.json()).catch(() => []);
    }
  }

  const [pinned, recent, searched] = await Promise.all([pinnedP, recentP, searchP]);
  const seen = new Set();
  const merged = [];
  for (const m of [...pinned, ...searched, ...recent]) {
    if (m && m.id && !seen.has(m.id)) {
      seen.add(m.id);
      merged.push(m);
    }
  }
  return merged.slice(0, 50); // cap to keep prompt size sane
}

function formatMemories(memories) {
  const grouped = {};
  for (const m of memories) {
    const cat = m.category || 'other';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(m);
  }

  let block = '═══════════════════════════════════════════════\nYOUR MEMORY — Things you have learned and should treat as known facts:\n═══════════════════════════════════════════════\n\n';

  const labels = {
    person: 'PEOPLE',
    business: 'BUSINESS FACTS',
    preference: 'SRINI\'S PREFERENCES',
    decision: 'PAST DECISIONS',
    other: 'OTHER',
  };

  for (const cat of ['person', 'business', 'preference', 'decision', 'other']) {
    if (!grouped[cat] || grouped[cat].length === 0) continue;
    block += `── ${labels[cat]} ──\n`;
    for (const m of grouped[cat]) {
      const pin = m.pinned ? '📌 ' : '';
      const ctx = m.context ? ` (${m.context})` : '';
      block += `${pin}${m.content}${ctx}\n`;
    }
    block += '\n';
  }

  block += `\nUse this knowledge naturally. Never say "according to my memory" or "I recall" — just speak as if you know it. If something in memory contradicts what Srini just said, trust what he just said and we'll update memory afterward.`;
  return block;
}

// ─── BACKGROUND: extract new memories from the exchange ─
async function extractMemories(userMsg, assistantReply, API_KEY, SUPABASE_URL, SUPABASE_KEY) {
  const extractionPrompt = `You just observed an exchange between Srini and Chuchi (his Chief of Staff AI).

USER (Srini) said:
${userMsg}

CHUCHI replied:
${assistantReply}

Your job: identify NEW facts worth remembering long-term. Categories:
- person: people mentioned, their roles, relationships
- business: business facts (events, products, prices, dates, capacities, URLs)
- preference: how Srini likes things done
- decision: choices made and the reasoning

Rules:
- Only extract NEW facts stated directly by Srini. Don't extract things Chuchi said unless Srini confirmed them.
- Skip conversational filler ("thanks", "ok", "got it").
- Skip things that are time-bound and will be stale tomorrow (e.g., "it's 3pm now").
- For each fact, decide auto-save vs needs-confirmation:
  - auto-save: clear, factual, stated directly by Srini, low ambiguity
  - confirm: inferred from tone, contradicts existing memory, sensitive (financial/personal), or a generalization across multiple messages

Respond with ONLY valid JSON, no other text:
{
  "auto_save": [
    {"category": "person|business|preference|decision", "content": "the fact in one sentence", "context": "brief why/when"}
  ],
  "confirm": [
    {"category": "...", "content": "...", "context": "...", "reason": "why you flagged this for confirmation"}
  ]
}

If nothing is worth saving, respond with: {"auto_save": [], "confirm": []}`;

  try {
    const r = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001', // cheap + fast for extraction
        max_tokens: 600,
        messages: [{ role: 'user', content: extractionPrompt }],
      }),
    });

    if (!r.ok) return;
    const data = await r.json();
    const text = data.content?.[0]?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return;

    const extracted = JSON.parse(jsonMatch[0]);
    const sbHeaders = {
      'Content-Type': 'application/json',
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
    };

    // Auto-save
    for (const m of extracted.auto_save || []) {
      if (!m.content) continue;
      await fetch(`${SUPABASE_URL}/rest/v1/memories`, {
        method: 'POST',
        headers: sbHeaders,
        body: JSON.stringify({
          category: m.category || 'other',
          content: m.content,
          context: m.context || null,
        }),
      });
    }

    // Queue for confirmation
    for (const m of extracted.confirm || []) {
      if (!m.content) continue;
      await fetch(`${SUPABASE_URL}/rest/v1/pending_memories`, {
        method: 'POST',
        headers: sbHeaders,
        body: JSON.stringify({
          category: m.category || 'other',
          content: m.content,
          context: m.context || null,
          reason: m.reason || null,
        }),
      });
    }
  } catch (err) {
    console.error('extractMemories error:', err);
  }
}
