// ============================================================
// /api/login
// POST { password }
// Returns { token } if password matches APP_PASSWORD
// Token is a signed timestamp + random nonce, no library needed
// ============================================================

import crypto from 'node:crypto';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const APP_PASSWORD = process.env.APP_PASSWORD;
  const APP_SECRET = process.env.APP_SECRET;

  if (!APP_PASSWORD || !APP_SECRET) {
    return res.status(500).json({ error: 'Auth not configured' });
  }

  const { password } = req.body || {};
  if (!password) {
    return res.status(400).json({ error: 'Password required' });
  }

  // Constant-time comparison to prevent timing attacks
  const expected = Buffer.from(APP_PASSWORD, 'utf8');
  const given = Buffer.from(String(password), 'utf8');
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
    // Small delay on failure to slow brute force
    await new Promise(r => setTimeout(r, 500));
    return res.status(401).json({ error: 'Wrong password' });
  }

  // Build a signed token. Payload = base64(timestamp + nonce)
  // Signature = HMAC-SHA256(payload, APP_SECRET)
  const ts = Date.now();
  const nonce = crypto.randomBytes(16).toString('hex');
  const payload = Buffer.from(`${ts}.${nonce}`).toString('base64url');
  const sig = crypto
    .createHmac('sha256', APP_SECRET)
    .update(payload)
    .digest('base64url');
  const token = `${payload}.${sig}`;

  return res.status(200).json({ token });
}
