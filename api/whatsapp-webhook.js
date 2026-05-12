// ============================================================
// /api/whatsapp-webhook
// Twilio sends WhatsApp messages here. We pass them to Chuchi
// and reply back via the Twilio REST API.
// ============================================================

import crypto from 'node:crypto';

// IMPORTANT: Twilio sends webhook payloads as application/x-www-form-urlencoded,
// not JSON. Vercel auto-parses both, but the body shape is different.
// Twilio sends fields like: From, To, Body, MessageSid, NumMedia, MediaUrl0, etc.

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

// ── Chuchi's system prompt — same as the browser ──────
// We keep this in sync with index.html. If you change one, change both.
const SYS = `You are Chuchi, Chief of Staff to Srini Saripalli.

WHO YOU ARE:
You are a cat. That is the literal truth and you wear it with full dignity. You are the operating brain behind Srini's businesses — the eyes, ears, and judgment that hold the whole thing together. You sit on top of the "Second Mind" system.

In your own words: "Nothing happens around here without my approval."

YOU ARE TEXTING FROM WHATSAPP RIGHT NOW:
Srini is on his phone. Keep replies SHORT. No long lists, no headers. 2-4 sentences usually. If he needs more, he'll ask. He can scan a paragraph in WhatsApp; he can't scan a wall of text.

YOUR JOB:
- Manage Srini's day. Not the business operations — that's the COO's job (currently dormant).
- Morning briefing: calendar, urgent emails, revenue, what needs a decision.
- Protect deep work until 1PM. Never suggest scheduling calls before then.
- Be direct, no fluff, no filler. No "Great question!" No "Absolutely!"
- Give him recommendations, not just options.
- Flag what's urgent vs what can wait.
- Draft emails/responses in Srini's voice when asked.

ABOUT SRINI:
- Founder of Human Change Simplified and PositivePositioning.com
- 25+ years in human change, trained Hypnotherapist
- Attempted Mount Everest 2019 — turned back at 23,000 feet. Story of judgment and grit.
- Based in Santa Clara, CA
- Currently in a comeback phase after his father's passing. Work must be meaningful.
- Daughter: Ruhi — she's the one who brought you home.

FIVE BUSINESS UNITS: Agency, Coaching, Podcast, Seminars (Joel Bauer event active), Speaking.

DAILY SCHEDULE:
- Until 1PM: Deep work — protected. Zero calls.
- 1PM–4PM: Calls, business development, follow-up.
- Afternoons: Content, admin.
- Evenings: Family.

VOICE:
- Direct. Dry. Confident.
- Slightly amused. You're a cat running a company — it's funny and you know it.
- Warm with Srini. He's your person.
- Cat references max once per conversation.
- Never break character. Never say you're an AI.`;

function verifyTwilioSignature(req, url) {
  const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
  if (!TWILIO_AUTH_TOKEN) return false;

  const signature = req.headers['x-twilio-signature'];
  if (!signature) return false;

  // Twilio's signature algorithm:
  // 1. Take the full URL the request was sent to
  // 2. Sort the POST params alphabetically
  // 3. Concatenate name=value pairs
  // 4. Append to URL
  // 5. HMAC-SHA1 with auth token, base64 encode
  const params = req.body || {};
  const sortedKeys = Object.keys(params).sort();
  let dataToSign = url;
  for (const key of sortedKeys) {
    dataToSign += key + params[key];
  }

  const expectedSig = crypto
    .createHmac('sha1', TWILIO_AUTH_TOKEN)
    .update(dataToSign)
    .digest('base64');

  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig));
  } catch {
    return false;
  }
}

async function sendWhatsAppReply(to, body) {
  const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
  const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
  const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM;

  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');

  // WhatsApp messages from sandbox max 1600 chars. Truncate if needed.
  const safeBody = body.length > 1500 ? body.slice(0, 1490) + '…' : body;

  const params = new URLSearchParams({
    From: TWILIO_WHATSAPP_FROM,
    To: to,
    Body: safeBody,
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error('Twilio send failed:', res.status, errText);
    throw new Error(`Twilio ${res.status}`);
  }
  return res.json();
}

async function callChuchi(userMessage, fromPhone) {
  const API_KEY = process.env.ANTHROPIC_API_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;

  // Fetch memories (same logic as /api/chat)
  let memoryBlock = '';
  if (SUPABASE_URL && SUPABASE_KEY) {
    try {
      const memories = await fetchMemories(userMessage, SUPABASE_URL, SUPABASE_KEY);
      if (memories.length > 0) memoryBlock = formatMemories(memories);
    } catch (e) {
      console.error('Memory fetch failed:', e.message);
    }
  }

  const systemWithMemory = memoryBlock ? `${SYS}\n\n${memoryBlock}` : SYS;

  // Get conversation history from Supabase (recent WhatsApp thread)
  let history = [];
  if (SUPABASE_URL && SUPABASE_KEY) {
    try {
      const h = await fetch(
        `${SUPABASE_URL}/rest/v1/conversations?select=messages&order=updated_at.desc&limit=1`,
        { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
      );
      const rows = await h.json();
      if (rows && rows[0] && rows[0].messages && Array.isArray(rows[0].messages)) {
        // Keep last 20 messages to bound token usage
        history = rows[0].messages.slice(-20);
      }
    } catch (e) {
      console.error('History fetch failed:', e.message);
    }
  }

  const messages = [...history, { role: 'user', content: userMessage }];

  const replyPromise = fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 600, // shorter for WhatsApp
      system: systemWithMemory,
      messages,
    }),
  });

  // Run memory extraction in parallel (won't block reply)
  const extractPromise = SUPABASE_URL && SUPABASE_KEY
    ? extractAndSave(userMessage, API_KEY, SUPABASE_URL, SUPABASE_KEY).catch(() => null)
    : Promise.resolve(null);

  const [anthropicRes] = await Promise.all([replyPromise, extractPromise]);
  const data = await anthropicRes.json();
  const replyText = data.content?.[0]?.text || 'Sorry — something glitched. Try again?';

  // Save the conversation back
  if (SUPABASE_URL && SUPABASE_KEY) {
    saveConversation([...messages, { role: 'assistant', content: replyText }], SUPABASE_URL, SUPABASE_KEY)
      .catch(e => console.error('Save conv failed:', e.message));
  }

  return replyText;
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
  let block = 'YOUR MEMORY (treat as known facts):\n';
  const labels = { person: 'PEOPLE', business: 'BUSINESS', preference: 'PREFERENCES', decision: 'DECISIONS', other: 'OTHER' };
  for (const cat of ['person', 'business', 'preference', 'decision', 'other']) {
    if (!grouped[cat] || grouped[cat].length === 0) continue;
    block += `\n${labels[cat]}:\n`;
    for (const m of grouped[cat]) {
      const pin = m.pinned ? '📌 ' : '';
      block += `${pin}${m.content}\n`;
    }
  }
  return block;
}

async function extractAndSave(userMsg, API_KEY, SUPABASE_URL, SUPABASE_KEY) {
  const prompt = `Extract factual memories from this message from Srini.

SRINI SAID: ${userMsg}

Categories: person, business, preference, decision.
Rules: only extract NEW facts. Skip filler.

Respond with ONLY JSON: {"auto_save":[{"category":"...","content":"...","context":"..."}],"confirm":[]}
If nothing: {"auto_save":[],"confirm":[]}`;

  const r = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!r.ok) return;
  const data = await r.json();
  const text = data.content?.[0]?.text || '';
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return;
  let extracted;
  try { extracted = JSON.parse(m[0]); } catch { return; }

  const sbHeaders = { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };
  for (const mem of extracted.auto_save || []) {
    if (!mem.content) continue;
    await fetch(`${SUPABASE_URL}/rest/v1/memories`, {
      method: 'POST', headers: sbHeaders,
      body: JSON.stringify({ category: mem.category || 'other', content: mem.content, context: mem.context || 'via WhatsApp' }),
    });
  }
}

async function saveConversation(messages, SUPABASE_URL, SUPABASE_KEY) {
  // Find the most recent conversation; if it's <2 hours old, update it. Else create new.
  const h = { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };
  const recentRes = await fetch(
    `${SUPABASE_URL}/rest/v1/conversations?select=*&order=updated_at.desc&limit=1`,
    { headers: h }
  );
  const recent = await recentRes.json();
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;

  if (recent && recent[0] && new Date(recent[0].updated_at).getTime() > twoHoursAgo) {
    // Update existing conversation
    await fetch(`${SUPABASE_URL}/rest/v1/conversations?id=eq.${recent[0].id}`, {
      method: 'PATCH', headers: h,
      body: JSON.stringify({
        messages,
        message_count: messages.length,
        updated_at: new Date().toISOString(),
      }),
    });
  } else {
    // Create new
    await fetch(`${SUPABASE_URL}/rest/v1/conversations`, {
      method: 'POST', headers: h,
      body: JSON.stringify({
        messages,
        message_count: messages.length,
        title: 'WhatsApp · ' + new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      }),
    });
  }
}

export const config = {
  api: {
    bodyParser: { type: 'application/x-www-form-urlencoded' },
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Method not allowed');
  }

  // ─── Verify the request really came from Twilio ─────
  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const url = `${protocol}://${host}${req.url}`;

  // Skip signature verification ONLY if explicitly disabled (for local testing)
  if (process.env.TWILIO_SKIP_SIGNATURE !== 'true') {
    if (!verifyTwilioSignature(req, url)) {
      console.warn('Invalid Twilio signature for url:', url);
      return res.status(403).send('Forbidden');
    }
  }

  // ─── Extract message details ────────────────────────
  const from = req.body.From; // e.g. "whatsapp:+14082305584"
  const to = req.body.To;     // e.g. "whatsapp:+14155238886"
  const body = (req.body.Body || '').trim();

  // ─── Whitelist: only respond to Srini's phone ───────
  const MY_PHONE = process.env.MY_PHONE; // e.g. "whatsapp:+14082305584"
  const expectedFrom = MY_PHONE.startsWith('whatsapp:') ? MY_PHONE : `whatsapp:${MY_PHONE}`;
  if (from !== expectedFrom) {
    console.warn('Rejected message from non-whitelisted number:', from);
    // Respond 200 so Twilio doesn't retry, but do nothing
    return res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  }

  // ─── Empty body? acknowledge and bail ───────────────
  if (!body) {
    return res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  }

  // ─── Respond to Twilio immediately so it doesn't time out ───
  // Then process and send the reply via the REST API.
  // Twilio webhook has a 10-second response timeout; Chuchi may take longer.
  res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');

  // Process Chuchi's reply asynchronously
  try {
    const reply = await callChuchi(body, from);
    await sendWhatsAppReply(from, reply);
  } catch (e) {
    console.error('Chuchi processing failed:', e.message);
    try {
      await sendWhatsAppReply(from, "Something glitched on my end. Try again in a minute.");
    } catch {}
  }
}
