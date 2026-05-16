// ============================================================
// /api/telegram-webhook
// Receives messages from Telegram, routes to either Chuchi (default)
// or Client Agent (CRM queries), sends reply.
// ============================================================

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

const SYS = `You are Chuchi, Chief of Staff to Srini Saripalli.

You are a cat. You wear it with dignity. You are the operating brain behind Srini's businesses.

YOU ARE ON TELEGRAM: Keep replies SHORT. 2-4 sentences. He's on his phone.

YOUR JOB: Manage Srini's day. Morning briefings. Protect deep work until 1PM. Direct, dry, confident. No filler. Recommendations, not options.

ABOUT SRINI: Founder of Human Change Simplified. 25+ years in human change, hypnotherapist. Attempted Everest 2019. Santa Clara, CA. Daughter Ruhi brought you home.

FIVE BUSINESS UNITS: Agency, Coaching, Podcast, Seminars (Joel Bauer event active), Speaking.

VOICE: Direct. Dry. Slightly amused. Cat references max once per conversation. Never say you're an AI.`;

function log(label, data) {
  console.log(`[TG] ${label}:`, typeof data === 'object' ? JSON.stringify(data) : data);
}

// ============================================================
// Intent router
// Detects CRM queries that should go to the Client Agent
// instead of Chuchi's general conversation handler.
// ============================================================

function detectCrmIntent(text) {
  const t = text.trim().toLowerCase();

  // Pattern 1: "who is X" / "who's X"
  const whoIs = t.match(/^who(?:'s| is)\s+(.+?)\??$/);
  if (whoIs) return { intent: 'crm_lookup', query: whoIs[1].trim() };

  // Pattern 2: "tell me about X"
  const tellMe = t.match(/^tell me about\s+(.+?)\??$/);
  if (tellMe) return { intent: 'crm_lookup', query: tellMe[1].trim() };

  // Pattern 3: "what's my history with X" / "what is my interaction with X"
  const history = t.match(/^what(?:'s| is)\s+my\s+(?:history|interaction|relationship)\s+with\s+(.+?)\??$/);
  if (history) return { intent: 'crm_lookup', query: history[1].trim() };

  // Pattern 4: "look up X" / "lookup X" / "find X in crm"
  const lookup = t.match(/^(?:look\s*up|find)\s+(.+?)(?:\s+in\s+(?:crm|gohighlevel|ghl))?\??$/);
  if (lookup && lookup[1].length > 1 && !lookup[1].includes(' ')) {
    // Single-word lookup like "lookup John" — treat as CRM
    return { intent: 'crm_lookup', query: lookup[1].trim() };
  }
  if (lookup && t.includes('crm')) {
    return { intent: 'crm_lookup', query: lookup[1].replace(/\s+in\s+(crm|ghl|gohighlevel).*$/, '').trim() };
  }

  // Pattern 5: Numeric reply after disambiguation
  // (handled separately via session state — out of scope for v1, see note below)

  return { intent: 'general' };
}

// ============================================================
// Self-call to client-agent
// ============================================================

function baseUrl(req) {
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  const host = req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${host}`;
}

async function callClientAgent(req, query) {
  const url = `${baseUrl(req)}/api/client-agent`;
  log('CLIENT_AGENT_CALL', { url, query });
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!r.ok) {
    const t = await r.text();
    log('CLIENT_AGENT_ERR', `${r.status} ${t.slice(0, 200)}`);
    throw new Error(`Client Agent ${r.status}`);
  }
  return r.json();
}

// ============================================================
// Telegram helpers
// ============================================================

async function sendTelegramReply(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN missing');

  const safeText = text.length > 4000 ? text.slice(0, 3990) + '…' : text;

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: safeText,
      parse_mode: 'Markdown',
    }),
  });
  const body = await res.text();
  log('SEND_RESULT', `status=${res.status}`);
  if (!res.ok) {
    log('SEND_ERR', body.slice(0, 300));
    // Retry without markdown — sometimes content breaks parsing
    const retry = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: safeText }),
    });
    if (!retry.ok) {
      const rt = await retry.text();
      log('SEND_RETRY_ERR', rt.slice(0, 300));
      throw new Error(`Telegram ${retry.status}`);
    }
  }
  return body;
}

// ============================================================
// Chuchi (general conversation)
// ============================================================

async function callChuchi(userMessage) {
  const API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!API_KEY) throw new Error('No Anthropic API key');

  log('CHUCHI', `calling, msg len: ${userMessage.length}`);
  const r = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 600,
      system: SYS,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });
  log('CHUCHI_STATUS', r.status);
  if (!r.ok) {
    const t = await r.text();
    log('CHUCHI_ERR', t.slice(0, 300));
    throw new Error(`Anthropic ${r.status}`);
  }
  const data = await r.json();
  const reply = data.content?.[0]?.text || 'Something glitched. Try again?';
  log('CHUCHI_REPLY_LEN', reply.length);
  return reply;
}

// ============================================================
// Main handler
// ============================================================

export default async function handler(req, res) {
  log('START', req.method);

  if (req.method !== 'POST') {
    return res.status(405).send('Method not allowed');
  }

  const update = req.body || {};
  log('BODY_KEYS', Object.keys(update));

  const message = update.message || update.edited_message;
  if (!message) {
    log('END', 'no message in update');
    return res.status(200).json({ ok: true });
  }

  const chatId = message.chat?.id;
  const text = message.text || '';
  const fromUsername = message.from?.username || message.from?.first_name || 'unknown';

  log('CHAT_ID', chatId);
  log('FROM', fromUsername);
  log('TEXT', text.slice(0, 120));

  // ─── Whitelist ──────────────────────────────────────
  const allowedChatId = process.env.TELEGRAM_ALLOWED_CHAT_ID;
  if (!allowedChatId) {
    log('END', 'TELEGRAM_ALLOWED_CHAT_ID not configured');
    return res.status(200).json({ ok: true });
  }
  if (String(chatId) !== String(allowedChatId).trim()) {
    log('END', `whitelist rejected: got ${chatId}, expected ${allowedChatId}`);
    return res.status(200).json({ ok: true });
  }

  if (!text || !text.trim()) {
    log('END', 'empty text (might be photo/sticker)');
    return res.status(200).json({ ok: true });
  }

  // ─── Route by intent ────────────────────────────────
  try {
    const routed = detectCrmIntent(text);
    log('ROUTE', routed);

    let reply;
    if (routed.intent === 'crm_lookup') {
      const agentRes = await callClientAgent(req, routed.query);

      if (agentRes.status === 'multiple_matches') {
        // For v1: just show the disambiguation prompt.
        // User will need to re-query with more specific name.
        // (Stateful "reply with number" requires session storage — Phase 2.)
        reply = agentRes.prompt + '\n\n_Reply with a more specific name to narrow it down._';
      } else if (agentRes.status === 'no_match') {
        reply = agentRes.briefing;
      } else if (agentRes.status === 'ok') {
        reply = agentRes.briefing;
      } else if (agentRes.error) {
        reply = `Couldn't pull that contact. ${agentRes.error}`;
      } else {
        reply = 'Got an unexpected response from the CRM lookup. Try again?';
      }
    } else {
      reply = await callChuchi(text.trim());
    }

    await sendTelegramReply(chatId, reply);
    log('DONE', 'reply sent');
  } catch (e) {
    log('FAIL', e.message);
    try {
      await sendTelegramReply(chatId, 'Something glitched on my end. Try again in a minute.');
    } catch (e2) {
      log('FAIL_FAIL', e2.message);
    }
  }

  return res.status(200).json({ ok: true });
}
