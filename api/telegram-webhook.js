// ============================================================
// /api/telegram-webhook
// Receives messages from Telegram, calls Chuchi, sends reply.
// Sits ALONGSIDE the WhatsApp webhook — both can work independently.
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

async function sendTelegramReply(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN missing');

  // Telegram max message length is 4096 chars — generous, but let's cap anyway
  const safeText = text.length > 4000 ? text.slice(0, 3990) + '…' : text;

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: safeText,
      // parse_mode: 'Markdown',  // off by default — markdown can break on stray chars
    }),
  });
  const body = await res.text();
  log('SEND_RESULT', `status=${res.status}`);
  if (!res.ok) {
    log('SEND_ERR', body.slice(0, 300));
    throw new Error(`Telegram ${res.status}`);
  }
  return body;
}

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
      model: 'claude-sonnet-4-20250514',
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

export default async function handler(req, res) {
  log('START', req.method);

  if (req.method !== 'POST') {
    return res.status(405).send('Method not allowed');
  }

  // Telegram sends JSON; Vercel parses it automatically
  const update = req.body || {};
  log('BODY_KEYS', Object.keys(update));

  // Telegram update shape:
  // { update_id, message: { message_id, from: {...}, chat: { id, ... }, text } }
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
  // Only respond to Srini's personal chat
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

  // ─── Synchronous Chuchi call + reply ────────────────
  // Same approach as WhatsApp webhook — do all work before responding.
  // Vercel Hobby kills functions after res.send() returns.
  try {
    const reply = await callChuchi(text.trim());
    await sendTelegramReply(chatId, reply);
    log('DONE', 'reply sent');
  } catch (e) {
    log('FAIL', e.message);
    try {
      await sendTelegramReply(chatId, "Something glitched on my end. Try again in a minute.");
    } catch (e2) {
      log('FAIL_FAIL', e2.message);
    }
  }

  // Acknowledge Telegram. Body doesn't matter — they just want a 200.
  return res.status(200).json({ ok: true });
}
