// ============================================================
// /api/client-agent
// Second Mind: Client Agent.
// Takes a contact query, fans out to GHL + Calendar in parallel,
// merges duplicate CRM records for the same person,
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

function baseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL;
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

**Who:** [Name], [role/company if known], [source if known], entered [date]. If duplicate records exist for the same person, append "(merged from N CRM records)".
**Status:** [Lifecycle tag(s) — pick max 2 most signal-rich and human-readable], [deal stage if any], [deal value if any].
**Last touch:** [Most recent meaningful interaction — date + plain-English description].
**Open loop:** [What's pending: your reply owed / their reply owed / scheduled / nothing active].
**Signal:** [One line of judgment synthesizing the whole picture].

CRITICAL RULES:
- Be DIRECT. No fluff. No preamble. No "based on the data."
- If a field's meaning is unclear (e.g. cryptic strings like "Abndt", "PPMC", short codes), OMIT it. Never guess. Never include raw data you can't interpret.
- Never expose internal data shapes to the user. No "type 3", no GHL field codes, no raw enum values. Translate everything into plain English or omit it.
- For tags: pick max 2 that carry real signal (e.g. "mentoring4millions-paid-attendee" → "Paid M4M attendee"). Skip noise tags: imported, openedonghl, no engagement, single-word tags you can't decode, anything that looks like a date string or filename.
- For **Signal**: this is the line Srini reads first. It must synthesize across all data — engagement pattern, recency, conversion status, lifecycle. NOT a restatement of other fields.
- If a field has nothing meaningful, write "none" or "unknown" — don't pad.
- Do NOT use headers, intros, or closing remarks. Just the 5 lines.
- Markdown bold on field labels only.`;

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

    const ghl = await callGhlLookup(req, { query, contactId, includeMessages: true });
    log('GHL_STATUS', ghl.status);

    if (ghl.error) {
      return res.status(500).json({ error: `GHL lookup failed: ${ghl.error}` });
    }

    if (ghl.status === 'no_match') {
      return res.status(200).json({
        status: 'no_match',
        query,
        briefing: `No contact found matching "${query}" in GoHighLevel.`,
      });
    }

    let mergedContact = null;
    let mergedSources = [];
    let duplicateCount = 0;

    if (ghl.status === 'multiple_matches') {
      const groups = groupBySameHuman(ghl.matches);
      log('MATCH_GROUPS', `${groups.length} distinct humans across ${ghl.matches.length} records`);

      if (groups.length === 1) {
        mergedSources = groups[0].map(m => m.id);
        mergedContact = mergeContacts(groups[0]);
        duplicateCount = groups[0].length;
        log('MERGED', `${duplicateCount} duplicate records`);
      } else {
        const reps = groups.map(group => ({
          ...mergeContacts(group),
          _duplicateCount: group.length,
        }));
        log('DISAMBIG', `${reps.length} distinct people`);
        return res.status(200).json({
          status: 'multiple_matches',
          query,
          matches: reps,
          prompt: formatDisambigPrompt(reps),
        });
      }
    } else if (ghl.status === 'ok') {
      mergedContact = ghl.contact;
      mergedSources = [ghl.contact.id];
      duplicateCount = 1;
    }

    // Aggregate data across all merged records
    let opportunities = ghl.opportunities || [];
    let notes = ghl.notes || [];
    let tasks = ghl.tasks || [];
    let conversations = ghl.conversations || [];
    let recentMessages = ghl.recentMessages || [];

    if (duplicateCount > 1) {
      const fanOutPromises = mergedSources.map(id =>
        callGhlLookup(req, { contactId: id, includeMessages: true })
      );
      const fanOutResults = await Promise.all(fanOutPromises);

      opportunities = [];
      notes = [];
      tasks = [];
      conversations = [];
      recentMessages = [];

      for (const r of fanOutResults) {
        if (r.status !== 'ok') continue;
        opportunities.push(...(r.opportunities || []));
        notes.push(...(r.notes || []));
        tasks.push(...(r.tasks || []));
        conversations.push(...(r.conversations || []));
        recentMessages.push(...(r.recentMessages || []));
      }

      conversations.sort((a, b) => (b.lastMessageDate || 0) - (a.lastMessageDate || 0));
      notes.sort((a, b) =>
        new Date(b.dateAdded || 0).getTime() - new Date(a.dateAdded || 0).getTime()
      );
    }

    // Calendar (if enabled)
    const contactEmail = mergedContact?.email;
    const contactName = mergedContact?.name;
    let calendar = { past: [], upcoming: [] };

    if (process.env.CALENDAR_ENABLED === 'true' && contactEmail) {
      try {
        const calRes = await callCalendarSearch(req, { email: contactEmail, name: contactName });
        if (!calRes.error) {
          calendar = { past: calRes.past || [], upcoming: calRes.upcoming || [] };
        }
      } catch (e) {
        log('CAL_EXCEPTION', e.message);
      }
    }

    // Synthesize
    const synthesisInput = buildSynthesisInput({
      contact: mergedContact,
      duplicateCount,
      opportunities,
      notes,
      tasks,
      conversations,
      recentMessages,
      calendar,
    });

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
      return res.status(500).json({ error: `Claude API ${claudeRes.status}` });
    }

    const claudeData = await claudeRes.json();
    const briefing = claudeData.content?.[0]?.text || '(no briefing generated)';

    return res.status(200).json({
      status: 'ok',
      briefing,
      raw: { contact: mergedContact, duplicateCount, opportunities, notes, tasks, conversations, calendar },
    });
  } catch (err) {
    log('FATAL', err.message);
    return res.status(500).json({ error: err.message });
  }
}

// ============================================================
// Duplicate detection & merging
// ============================================================

function groupBySameHuman(matches) {
  const groups = [];
  for (const m of matches) {
    const email = (m.email || '').toLowerCase().trim();
    const phone = normalizePhone(m.phone);
    let foundGroup = null;
    for (const g of groups) {
      for (const existing of g) {
        const eEmail = (existing.email || '').toLowerCase().trim();
        const ePhone = normalizePhone(existing.phone);
        if ((email && eEmail && email === eEmail) ||
            (phone && ePhone && phone === ePhone)) {
          foundGroup = g;
          break;
        }
      }
      if (foundGroup) break;
    }
    if (foundGroup) foundGroup.push(m);
    else groups.push([m]);
  }
  return groups;
}

function normalizePhone(p) {
  if (!p) return null;
  const digits = p.replace(/\D/g, '').replace(/^1/, '');
  return digits.length >= 10 ? digits : null;
}

function mergeContacts(group) {
  const sorted = [...group].sort((a, b) => fieldCount(b) - fieldCount(a));
  const base = sorted[0];
  const allTags = new Set();
  const allSources = new Set();
  let earliestDate = null;
  let latestUpdate = null;

  for (const c of group) {
    (c.tags || []).forEach(t => allTags.add(t));
    if (c.source) allSources.add(c.source);
    const added = c.dateAdded ? new Date(c.dateAdded).getTime() : null;
    const updated = c.dateUpdated ? new Date(c.dateUpdated).getTime() : null;
    if (added && (!earliestDate || added < earliestDate)) earliestDate = added;
    if (updated && (!latestUpdate || updated > latestUpdate)) latestUpdate = updated;
  }

  return {
    ...base,
    tags: Array.from(allTags),
    source: Array.from(allSources).join(' / ') || base.source,
    dateAdded: earliestDate ? new Date(earliestDate).toISOString() : base.dateAdded,
    dateUpdated: latestUpdate ? new Date(latestUpdate).toISOString() : base.dateUpdated,
    _mergedFrom: group.map(c => c.id),
  };
}

function fieldCount(c) {
  return ['email', 'phone', 'companyName', 'source', 'firstName', 'lastName']
    .filter(f => c[f]).length + (c.tags?.length || 0);
}

// ============================================================
// Helpers
// ============================================================

function formatDisambigPrompt(matches) {
  const lines = matches.slice(0, 8).map((m, i) => {
    const tags = cleanTags(m.tags || []).slice(0, 2);
    const tagPreview = tags.length ? tags.join(', ') : 'no tags';
    const source = m.source || 'unknown source';
    const dupNote = m._duplicateCount > 1 ? ` [${m._duplicateCount} records]` : '';
    return `${i + 1}. ${m.name} — ${source}${dupNote} (${tagPreview})`;
  });
  return `Found ${matches.length} distinct people. Which one?\n\n${lines.join('\n')}\n\nReply with a more specific name to narrow it down.`;
}

function cleanTags(tags) {
  // Noise tags: confirmed junk only. When in doubt, keep the tag and let
  // the LLM decide whether to surface it in the briefing.
  const noiseExact = new Set([
    'imported', 'openedonghl', 'no engagement',
    'gmail bounced contacts',
  ]);
  return tags.filter(t => {
    if (!t) return false;
    const lower = t.toLowerCase().trim();
    if (noiseExact.has(lower)) return false;
    if (/^\d{1,2}\/\d{1,2}\/\d{4}/.test(lower)) return false; // date strings like "5/27/2016 5:01 am"
    if (/^changed2unconfirm/.test(lower)) return false;
    // NOTE: keeping short tags — they may be meaningful business shorthand
    return true;
  });
}

function decodeConversationType(type) {
  const map = {
    'TYPE_PHONE': 'phone/SMS',
    'TYPE_EMAIL': 'email',
    'TYPE_SMS': 'SMS',
    'TYPE_FB': 'Facebook',
    'TYPE_IG': 'Instagram',
    'TYPE_WEBCHAT': 'web chat',
    'TYPE_CUSTOM': 'custom channel',
    'TYPE_LIVE_CHAT': 'live chat',
  };
  return map[type] || (type ? String(type).replace('TYPE_', '').toLowerCase() : 'unknown');
}

function decodeMessageType(type) {
  const stringMap = {
    'TYPE_CAMPAIGN_EMAIL': 'campaign email',
    'TYPE_CALL': 'phone call',
    'TYPE_SMS': 'SMS',
    'TYPE_EMAIL': 'email',
    'TYPE_FB': 'Facebook message',
    'TYPE_VOICEMAIL': 'voicemail',
  };
  const numMap = {
    1: 'SMS',
    2: 'email',
    3: 'campaign email engagement',
    4: 'campaign email',
    5: 'phone call',
    25: 'manual SMS',
    26: 'manual email',
  };
  if (stringMap[type]) return stringMap[type];
  if (numMap[type]) return numMap[type];
  return typeof type === 'string'
    ? type.replace('TYPE_', '').toLowerCase()
    : 'engagement event';
}

function buildSynthesisInput(data) {
  const c = data.contact || {};
  const cleanedTags = cleanTags(c.tags || []);

  const summary = {
    contact: {
      name: c.name,
      email: c.email,
      phone: c.phone,
      company: c.companyName,
      source: c.source,
      tags: cleanedTags.slice(0, 10),
      dateAdded: c.dateAdded,
      dateUpdated: c.dateUpdated,
      type: c.type,
    },
    duplicateRecordCount: data.duplicateCount,
    opportunities: (data.opportunities || []).map(o => ({
      name: o.name,
      status: o.status,
      value: o.monetaryValue,
      lastStageChangeAt: o.lastStageChangeAt,
      updatedAt: o.updatedAt,
    })),
    notes: (data.notes || [])
      .filter(n => n.body && n.body !== 'nullnull' && n.body.trim().length > 0)
      .slice(0, 5)
      .map(n => ({ body: n.body?.slice(0, 200), dateAdded: n.dateAdded })),
    tasks: (data.tasks || []).map(t => ({
      title: t.title,
      completed: t.completed,
      dueDate: t.dueDate,
    })),
    conversations: (data.conversations || []).slice(0, 5).map(co => ({
      channel: decodeConversationType(co.type),
      lastMessageType: decodeMessageType(co.lastMessageType),
      lastMessageDate: co.lastMessageDate
        ? new Date(co.lastMessageDate).toISOString()
        : null,
      direction: co.lastMessageDirection,
      body: co.lastMessageBody?.slice(0, 200) || null,
    })),
    recentMessages: (data.recentMessages || []).slice(0, 5).map(m => ({
      type: decodeMessageType(m.type),
      direction: m.direction,
      dateAdded: m.dateAdded,
      body: m.body?.slice(0, 200) || null,
    })),
    calendar: {
      past: (data.calendar?.past || []).slice(0, 5).map(e => ({ summary: e.summary, start: e.start })),
      upcoming: (data.calendar?.upcoming || []).slice(0, 5).map(e => ({ summary: e.summary, start: e.start })),
    },
  };

  return `Today's date: ${new Date().toISOString().slice(0, 10)}

Generate the 5-line briefing for this contact. Apply all rules — especially: omit anything you can't confidently interpret, translate all internal codes, never expose raw data shapes.

${JSON.stringify(summary, null, 2)}`;
}
