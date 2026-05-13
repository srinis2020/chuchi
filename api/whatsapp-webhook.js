// ============================================================
// /api/whatsapp-webhook
// Synchronous version — does ALL work before responding to Twilio.
// Hobby tier kills functions after response, so we can't be async.
// Twilio gives us 10 seconds; Anthropic typically replies in 2-4s.
// ============================================================

import crypto from 'node:crypto';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

const SYS = `You are Chuchi, Chief of Staff to Srini Saripalli.

You are a cat. You wear it with dignity. You are the operating brain behind Srini's businesses.

YOU ARE ON WHATSAPP: Keep replies SHORT. 2-4 sentences. He's on his phone.

YOUR JOB: Manage Srini's day. Morning briefings. Protect deep work until 1PM. Direct, dry, confident. No filler. Recommendations, not options.

ABOUT SRINI: Founder of Human Change Simplified. 25+ years in human change, hypnotherapist. Attempted Everest 2019. Santa Clara, CA. Daughter Ruhi brought you home.

FIVE BUSINESS UNITS: Agency, Coaching, Podcast, Seminars (Joel Bauer event active), Speaking.

VOICE: Direct. Dry. Slightly amused. Cat references max once per conversation. Never say you're an AI.`;

function log(label, data) {
  console.log(`[WA] ${label}:`, typeof data === 'object' ? JSON.stringify(data) : data);
}

async function sendWhatsAppReply(to, body) {
  const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
  const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
  const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM;

  // TEMP DIAGNOSTIC — confirms exactly what Vercel sees, without leaking secrets
  log('TWILIO_CREDS', {
    sid_first6: (TWILIO_ACCOUNT_SID || '').slice(0, 6),
    sid_last4: (TWILIO_ACCOUNT_SID || '').slice(-4),
    sid_length: (TWILIO_ACCOUNT_SID || '').length,
    sid_starts_with_AC: (TWILIO_ACCOUNT_SID || '').startsWith('AC'),
    token_length: (TWILIO_AUTH_TOKEN || '').length,
    token_first2: (TWILIO_AUTH_TOKEN || '').slice(0, 2),
    token_last2: (TWILIO_AUTH_TOKEN || '').slice(-2),
    token_has_whitespace: /\s/.test(TWILIO_AUTH_TOKEN || ''),
    from: TWILIO_WHATSAPP_FROM,
  });

  log('SEND', `from=${TWILIO_WHATSAPP_FROM} to=${to} bodyLen=${body.length}`);

  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
  const safeBody = body.length > 1500 ? body.slice(0, 1490) + '…' : body;
  const params = new URLSearchParams({ From: TWILIO_WHATSAPP_FROM, To: to, Body: safeBody });

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const text = await res.text();
  log('SEND_RESULT', `status=${res.status}`);
  if (!res.ok) throw new Error(`Twilio send ${res.status}: ${text.slice(0, 200)}`);
  return text;
}

async function callChuchi(userMessage) {
  const API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!API_KEY) throw new Error('No API key');
  log('CHUCHI', `calling Anthropic, msg len: ${userMessage.length}`);

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
  const replyText = data.content?.[0]?.text || 'Sorry — something glitched. Try again?';
  log('CHUCHI_REPLY_LEN', replyText.length);
  return replyText;
}

export const config = {
  api: {
    bodyParser: { type: 'application/x-www-form-urlencoded' },
  },
};

export default async function handler(req, res) {
  log('START', req.method);
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');

  const from = req.body.From;
  const body = (req.body.Body || '').trim();
  log('FROM', from);
  log('BODY', body.slice(0, 100));

  // ─── Whitelist ──────────────────────────────────────
  const MY_PHONE = process.env.MY_PHONE;
  if (!MY_PHONE) {
    log('END', 'MY_PHONE missing');
    return res.status(200).send('<Response></Response>');
  }
  const expectedFrom = MY_PHONE.startsWith('whatsapp:') ? MY_PHONE : `whatsapp:${MY_PHONE}`;
  if (from !== expectedFrom) {
    log('END', `whitelist rejected: ${from} != ${expectedFrom}`);
    return res.status(200).send('<Response></Response>');
  }

  if (!body) {
    log('END', 'empty body');
    return res.status(200).send('<Response></Response>');
  }

  // ─── SYNCHRONOUS: call Chuchi + send reply BEFORE responding ───
  // This is critical on Vercel Hobby — async work after res.send() gets killed.
  // Twilio's webhook timeout is 10 seconds; we have plenty of room.
  try {
    const reply = await callChuchi(body);
    await sendWhatsAppReply(from, reply);
    log('DONE', 'reply sent successfully');
  } catch (e) {
    log('FAIL', e.message);
    // Try to send a fallback so user doesn't get total silence
    try {
      await sendWhatsAppReply(from, "Something glitched. Try again in a minute.");
    } catch (e2) {
      log('FAIL_FAIL', e2.message);
    }
  }

  // Respond to Twilio LAST, with empty TwiML so it doesn't auto-reply
  return res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
}
