// ============================================================
// /api/chat — Chuchi's brain with memory + auth
// ============================================================

import crypto from 'node:crypto';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

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
  } catch {
    return false;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ─── AUTH GATE ────────────────────────────────────
  if (!verifyAuth(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const API_KEY = process.env.ANTHROPIC_API_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;
  if (!API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY missing' });

  const body = req.body || {};
  const messages = body.messages || [];
  const originalSystem = body.system || '';
  const latestUserMsg = [...messages].reverse().find(m => m.role === 'user')?.content || '';

  const memoryEnabled = !!(SUPABASE_URL && SUPABASE_KEY);
  const debug = { memory_enabled: memoryEnabled };

  try {
    let memoryBlock = '';
    if (memoryEnabled) {
      try {
        const memories = await fetchMemories(latestUserMsg, SUPABASE_URL, SUPABASE_KEY);
        debug.memories_retrieved = memories.length;
        if (memories.length > 0) memoryBlock = formatMemories(memories);
      } catch (e) {
        debug.memory_fetch_error = e.message;
      }
    }

    const systemWithMemory = memoryBlock ? `${originalSystem}\n\n${memoryBlock}` : originalSystem;

    const replyPromise = fetch(ANTHROPIC_URL, {
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

    const extractPromise = memoryEnabled && latestUserMsg
      ? extractAndSave(latestUserMsg, API_KEY, SUPABASE_URL, SUPABASE_KEY).catch(e => ({ error: e.message }))
      : Promise.resolve({ skipped: true });

    const [anthropicRes, extractResult] = await Promise.all([replyPromise, extractPromise]);
    const data = await anthropicRes.json();
    debug.extraction = extractResult;

    if (data && !data.error) data._debug = debug;
    return res.status(anthropicRes.status).json(data);
  } catch (error) {
    return res.status(500).json({ error: error.message, debug });
  }
}

async function fetchMemories(query, SUPABASE_URL, SUPABASE_KEY) {
  const h = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };
  const pinnedP = fetch(`${SUPABASE_URL}/rest/v1/memories?pinned=eq.true&select=*`, { headers: h }).then(r => r.json()).catch(() => []);
  const recentP = fetch(`${SUPABASE_URL}/rest/v1/memories?select=*&order=created_at.desc&limit=30`, { headers: h }).then(r => r.json()).catch(() => []);
  let searchP = Promise.resolve([]);
  if (query && query.trim()) {
    const terms = query.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2).slice(0, 8).join(' | ');
    if (terms) {
      searchP = fetch(`${SUPABASE_URL}/rest/v1/memories?content=fts.${encodeURIComponent(terms)}&select=*&limit=15`, { headers: h }).then(r => r.json()).catch(() => []);
    }
  }
  const [pinned, recent, searched] = await Promise.all([pinnedP, recentP, searchP]);
  const seen = new Set();
  const merged = [];
  for (const m of [...(pinned||[]), ...(searched||[]), ...(recent||[])]) {
    if (m && m.id && !seen.has(m.id)) { seen.add(m.id); merged.push(m); }
  }
  return merged.slice(0, 50);
}

function formatMemories(memories) {
  const grouped = {};
  for (const m of memories) {
    const cat = m.category || 'other';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(m);
  }
  let block = '═══════════════════════════════════════════════\nYOUR MEMORY — Things you have learned and should treat as known facts:\n═══════════════════════════════════════════════\n\n';
  const labels = { person: 'PEOPLE', business: 'BUSINESS FACTS', preference: "SRINI'S PREFERENCES", decision: 'PAST DECISIONS', other: 'OTHER' };
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
  block += `\nUse this knowledge naturally. Never say "according to my memory" or "I recall" — just speak as if you know it. If Srini just contradicted something in memory, trust what he just said.`;
  return block;
}

async function extractAndSave(userMsg, API_KEY, SUPABASE_URL, SUPABASE_KEY) {
  const extractionPrompt = `Extract factual memories from this message from Srini (founder of Human Change Simplified, runs 5 business units: Agency, Coaching, Podcast, Seminars, Speaking).

SRINI SAID: ${userMsg}

Categorize each fact:
- person: people, roles, relationships, contact info
- business: events, products, prices, dates, venues, URLs
- preference: how Srini likes things done
- decision: choices made + reasoning

Rules:
- Only extract NEW facts stated directly. Skip greetings, thanks, conversational filler.
- auto_save: clear, factual, low ambiguity
- confirm: inferred, uncertain ("I think", "maybe"), or sensitive

Respond with ONLY valid JSON, no markdown, no other text:
{"auto_save":[{"category":"...","content":"...","context":"..."}],"confirm":[{"category":"...","content":"...","context":"...","reason":"..."}]}

If nothing worth saving: {"auto_save":[],"confirm":[]}`;

  const r = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      messages: [{ role: 'user', content: extractionPrompt }],
    }),
  });
  if (!r.ok) throw new Error(`Haiku ${r.status}`);
  const data = await r.json();
  const text = data.content?.[0]?.text || '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { auto: 0, pending: 0 };

  let extracted;
  try { extracted = JSON.parse(jsonMatch[0]); }
  catch (e) { return { auto: 0, pending: 0, parse_error: e.message }; }

  const sbHeaders = { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };
  let autoCount = 0, pendingCount = 0;

  for (const m of extracted.auto_save || []) {
    if (!m.content) continue;
    const w = await fetch(`${SUPABASE_URL}/rest/v1/memories`, {
      method: 'POST', headers: sbHeaders,
      body: JSON.stringify({ category: m.category || 'other', content: m.content, context: m.context || null }),
    });
    if (w.ok) autoCount++;
  }
  for (const m of extracted.confirm || []) {
    if (!m.content) continue;
    const w = await fetch(`${SUPABASE_URL}/rest/v1/pending_memories`, {
      method: 'POST', headers: sbHeaders,
      body: JSON.stringify({ category: m.category || 'other', content: m.content, context: m.context || null, reason: m.reason || null }),
    });
    if (w.ok) pendingCount++;
  }
  return { auto: autoCount, pending: pendingCount };
}
