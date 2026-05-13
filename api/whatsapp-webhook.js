// ============================================================
// /api/whatsapp-webhook — debug/verbose version
// Every step logs explicitly so we can see where it fails.
// Once it's working, we'll trim the logs back down.
// ============================================================

import crypto from 'node:crypto';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

const SYS = `You are Chuchi, Chief of Staff to Srini Saripalli.

You are a cat. You wear it with dignity. You are the operating brain behind Srini's businesses.

YOU ARE ON WHATSAPP: Keep replies SHORT. 2-4 sentences. He's on his phone.

YOUR JOB: Manage Srini's day. Morning briefings. Protect deep work until 1PM. Direct, dry, confident. No filler. Recommendations, not options.

ABOUT SRINI: Founder of Human Change Simplified. 25+ years in human change, hypnotherapist. Attempted Everest 2019. Santa Clara, CA. Daughter Ruhi brought you home.

VOICE: Direct. Dry. Slightly amused. Cat references max once per conversation. Never say you're an AI.`;

function log(label, data) {
  console.log(`[WA] ${label}:`, typeof data === 'object' ? JSON.stringify(data) : data);
}

function verifyTwilioSignature(req, url) {
  const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
  if (!TWILIO_AUTH_TOKEN) { log('SIG', 'no auth token in env'); return false; }
  const signature = req.headers['x-twilio-signature'];
  if (!signature) { log('SIG', 'no signature header'); return false; }
  const params = req.body || {};
  const sortedKeys = Object.keys(params).sort();
  let dataToSign = url;
  for (const key of sortedKeys) dataToSign += key + params[key];
  const expectedSig = crypto.createHmac('sha1', TWILIO_AUTH_TOKEN).update(dataToSign).digest('base64');
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
  log('SEND_RESULT', `status=${res.status} body=${text.slice(0, 400)}`);
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${text.slice(0, 200)}`);
  return text;
}

async function callChuchi(userMessage) {
  const API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!API_KEY) { log('CHUCHI', 'no API key'); throw new Error('No API key'); }
  log('CHUCHI', `calling Anthropic with msg: ${userMessage.slice(0, 80)}`);
  const r = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
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
    log('CHUCHI_ERR', t.slice(0, 400));
    throw new Error(`Anthropic ${r.status}`);
  }
  const data = await r.json();
  const replyText = data.content?.[0]?.text || 'Sorry — something glitched. Try again?';
  log('CHUCHI_REPLY', replyText.slice(0, 120));
  return replyText;
}

export const config = {
  api: {
    bodyParser: { type: 'application/x-www-form-urlencoded' },
  },
};

export default async function handler(req, res) {
  log('START', `method=${req.method} url=${req.url}`);

  if (req.method !== 'POST') {
    log('END', 'not POST');
    return res.status(405).send('Method not allowed');
  }

  // Log env-var presence (not values)
  log('ENV', {
    has_anthropic: !!process.env.ANTHROPIC_API_KEY,
    has_twilio_sid: !!process.env.TWILIO_ACCOUNT_SID,
    has_twilio_token: !!process.env.TWILIO_AUTH_TOKEN,
    has_twilio_from: !!process.env.TWILIO_WHATSAPP_FROM,
    twilio_from_value: process.env.TWILIO_WHATSAPP_FROM,
    has_my_phone: !!process.env.MY_PHONE,
    my_phone_value: process.env.MY_PHONE,
  });

  // Log inbound body shape
  log('BODY_KEYS', Object.keys(req.body || {}));
  log('FROM', req.body.From);
  log('TO', req.body.To);
  log('BODY', req.body.Body);

  // Signature check — but for now DON'T fail on it, just log
  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const url = `${protocol}://${host}${req.url}`;
  const sigOK = verifyTwilioSignature(req, url);
  log('SIG_VALID', sigOK);
  // NOTE: not enforcing signature yet — we'll turn it back on once the rest works.

  const from = req.body.From;
  const body = (req.body.Body || '').trim();

  // ─── Whitelist check, with explicit logging ────────
  const MY_PHONE = process.env.MY_PHONE;
  if (!MY_PHONE) {
    log('END', 'MY_PHONE env var missing');
    return res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  }
  const expectedFrom = MY_PHONE.startsWith('whatsapp:') ? MY_PHONE : `whatsapp:${MY_PHONE}`;
  log('WHITELIST', `from=[${from}] expected=[${expectedFrom}] match=${from === expectedFrom}`);

  if (from !== expectedFrom) {
    log('END', 'whitelist rejected');
    return res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  }

  if (!body) {
    log('END', 'empty body');
    return res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  }

  // Acknowledge Twilio first so it doesn't time out (10 sec limit)
  res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  log('ACK', 'sent 200 to Twilio, now processing reply');

  try {
    const reply = await callChuchi(body);
    log('SENDING_REPLY', '');
    await sendWhatsAppReply(from, reply);
    log('DONE', 'reply sent');
  } catch (e) {
    log('FAIL', e.message);
    try {
      await sendWhatsAppReply(from, "Something glitched on my end. Try again in a minute.");
      log('FAIL_REPLY', 'sent fail message');
    } catch (e2) {
      log('FAIL_FAIL', e2.message);
    }
  }
}
