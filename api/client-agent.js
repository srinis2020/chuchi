// ============================================================
// /api/client-agent
// Second Mind: Client Agent.
// Takes a contact query, fans out to GHL + Calendar in parallel,
// returns a 5-line briefing.
//
// Read-only. No writes. No side effects.
//
// POST body: { "query": "John Doe" }  OR  { "contactId": "abc123" }
// Returns: { status, briefing, raw } or { status: "multiple_matches", matches }
// ============================================================

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

function log(label, data) {
  console.log(`[CLIENT_AGENT] ${label}:`, typeof data === 'object' ? JSON.stringify(data) : data);
}

// Self-call helpers so this agent can use sibling routes as tools
function baseUrl(req) {
  // Prefer explicit stable production URL (not subject to Vercel Deployment Protection)
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL;
  // Fallback: derive from request (uses the host Telegram called)
  const host = req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${host}`;
}

async function callGhlLookup(req, body) {
  const url = `${baseUrl(req)}/api/ghl-contact-lookup`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function callCalendarSearch(req, body) {
  const url = `${baseUrl(req)}/api/calendar-search`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

// ============================================================
// Briefing template — LOCKED
// ============================================================

const BRIEFING_SYSTEM_PROMPT = `You are the Client Agent inside Srini Saripalli's Second Mind. Your only job is to take CRM data and produce a 5-line briefing on a contact.

OUTPUT FORMAT — produce EXACTLY this structure, no more, no less:

**Who:** [Name], [role/company if known], [source if known], entered [date].
**Status:** [Lifecycle tag(s) — pick max 2 most signal-rich], [deal stage if any], [deal value if any].
**Last touch:** [Most recent meaningful interaction — date + one-line summary].
**Open loop:** [What's pending: your reply owed / their reply owed / scheduled / nothing active].
**Signal:** [One line of judgment — e.g. "warm and waiting," "cold, no response in 60 days," "long-term audience, never converted," "hot, deal closing this week"].

RULES:
- Be DIRECT. No fluff. No filler. No "based on the data" preamble.
- If a field is empty in source data, say "none" or "unknown" — don't fabricate.
- If there are duplicate CRM records for the same person, flag it on the **Who** line: "(N duplicate records in CRM)".
- Tags often contain dates and event names — pick the 2 most recent/signal-rich, ignore noise like "imported" or "openedonghl".
- For **Signal**, synthesize across all data. This is the line Srini reads first.
- Do NOT use headers, intros, or closing remarks. Just the 5 lines.
- Markdown bold on field labels only. No other formatting.`;

// ============================================================
// Main handler
// ============================================================

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  const API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY missing' });

  try {
    const { query, contactId } = req.body || {};
    if (!query && !contactId) {
      return res.status(400).json({ error: "Provide 'query' or 'contactId'" });
    }

    log('REQUEST', { query, contactId });

    // ── Step 1: GHL lookup ────────────────────────────
    const ghl = await callGhlLookup(req, { query, contactId, includeMessages: true });
    log('GHL_STATUS', ghl.status);

    if (ghl.error) {
      return res.status(500).json({ error: `GHL lookup failed: ${ghl.error}` });
    }

    // Handle disambiguation — bubble up to caller (Chuchi/Telegram)
    if (ghl.status === 'multiple_matches') {
      log('DISAMBIG', `${ghl.matches.length} matches`);
      return res.status(200).json({
        status: 'multiple_matches',
        query,
        matches: ghl.matches,
        // Pre-formatted text for Telegram display
        prompt: formatDisambigPrompt(ghl.matches),
      });
    }

    if (ghl.status === 'no_match') {
      log('NO_MATCH', query);
      return res.status(200).json({
        status: 'no_match',
        query,
        briefing: `No contact found matching "${query}" in GoHighLevel.`,
      });
    }

    // ── Step 2: Calendar search in parallel ───────────
    // Only attempt calendar if explicitly enabled. Skip silently when not configured.
    const contactEmail = ghl.contact?.email;
    const contactName = ghl.contact?.name;
    let calendar = { past: [], upcoming: [] };

    if (process.env.CALENDAR_ENABLED === 'true' && contactEmail) {
      try {
        const calRes = await callCalendarSearch(req, {
          email: contactEmail,
          name: contactName,
        });
        if (!calRes.error) {
          calendar = { past: calRes.past || [], upcoming: calRes.upcoming || [] };
        } else {
          log('CAL_ERROR', calRes.error);
          calendar.error = calRes.error;
        }
      } catch (e) {
        log('CAL_EXCEPTION', e.message);
        calendar.error = e.message;
      }
    } else {
      log('CAL_SKIPPED', 'CALENDAR_ENABLED not set or no email');
    }

    log('CAL_RESULT', `past=${calendar.past?.length || 0} upcoming=${calendar.upcoming?.length || 0}`);

    // ── Step 3: Synthesize briefing via Claude ────────
    const synthesisInput = buildSynthesisInput(ghl, calendar);
    log('SYNTH_INPUT_LEN', synthesisInput.length);

    const claudeRes = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 500,
        system: BRIEFING_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: synthesisInput }],
      }),
    });

    if (!claudeRes.ok) {
      const text = await claudeRes.text();
      log('CLAUDE_ERR', text.slice(0, 300));
      return res.status(500).json({ error: `Claude API ${claudeRes.status}: ${text.slice(0, 200)}` });
    }

    const claudeData = await claudeRes.json();
    const briefing = claudeData.content?.[0]?.text || '(no briefing generated)';
    log('BRIEFING_LEN', briefing.length);

    return res.status(200).json({
      status: 'ok',
      briefing,
      raw: {
        contact: ghl.contact,
        opportunities: ghl.opportunities,
        notes: ghl.notes,
        tasks: ghl.tasks,
        conversations: ghl.conversations,
        calendar,
      },
    });
  } catch (err) {
    log('FATAL', err.message);
    return res.status(500).json({ error: err.message });
  }
}

// ============================================================
// Helpers
// ============================================================

function formatDisambigPrompt(matches) {
  const lines = matches.slice(0, 8).map((m, i) => {
    const tagPreview = (m.tags || []).slice(0, 2).join(', ') || 'no tags';
    const source = m.source || 'unknown source';
    return `${i + 1}. ${m.name} — ${source} (${tagPreview})`;
  });
  return `Found ${matches.length} matches. Which one?\n\n${lines.join('\n')}\n\nReply with the number.`;
}

function buildSynthesisInput(ghl, calendar) {
  const c = ghl.contact || {};

  // Filter noise tags
  const noiseTags = new Set(['imported', 'openedonghl', 'no engagement']);
  const tags = (c.tags || []).filter(t => !noiseTags.has(t.toLowerCase()));

  const summary = {
    contact: {
      name: c.name,
      email: c.email,
      phone: c.phone,
      company: c.companyName,
      source: c.source,
      tags: tags.slice(0, 8),
      dateAdded: c.dateAdded,
      dateUpdated: c.dateUpdated,
      type: c.type,
    },
    opportunities: (ghl.opportunities || []).map(o => ({
      name: o.name,
      status: o.status,
      value: o.monetaryValue,
      pipelineStageId: o.pipelineStageId,
      lastStageChangeAt: o.lastStageChangeAt,
      updatedAt: o.updatedAt,
    })),
    notes: (ghl.notes || [])
      .filter(n => n.body && n.body !== 'nullnull')
      .slice(0, 5)
      .map(n => ({ body: n.body?.slice(0, 200), dateAdded: n.dateAdded })),
    tasks: (ghl.tasks || []).map(t => ({
      title: t.title,
      completed: t.completed,
      dueDate: t.dueDate,
    })),
    conversations: (ghl.conversations || []).slice(0, 5).map(co => ({
      type: co.type,
      lastMessageType: co.lastMessageType,
      lastMessageDate: co.lastMessageDate
        ? new Date(co.lastMessageDate).toISOString()
        : null,
      direction: co.lastMessageDirection,
      body: co.lastMessageBody?.slice(0, 200),
    })),
    recentMessages: (ghl.recentMessages || []).slice(0, 5).map(m => ({
      type: m.type,
      direction: m.direction,
      dateAdded: m.dateAdded,
      body: m.body?.slice(0, 200),
    })),
    calendar: {
      past: (calendar.past || []).slice(0, 5).map(e => ({
        summary: e.summary,
        start: e.start,
      })),
      upcoming: (calendar.upcoming || []).slice(0, 5).map(e => ({
        summary: e.summary,
        start: e.start,
      })),
      error: calendar.error,
    },
  };

  return `Today's date: ${new Date().toISOString().slice(0, 10)}

Generate the 5-line briefing for this contact:

${JSON.stringify(summary, null, 2)}`;
}
