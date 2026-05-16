// ============================================================
// /api/calendar-search
// Searches Google Calendar for past + upcoming events with a given attendee.
// Read-only.
//
// Auth: uses a Google service account OR OAuth refresh token.
// For Srini's setup: assumes GOOGLE_OAUTH_REFRESH_TOKEN flow (most common).
//
// POST body: { "email": "person@example.com", "name": "optional name fallback" }
// Returns: { past: [...], upcoming: [...] }
// ============================================================

function log(label, data) {
  console.log(`[CAL] ${label}:`, typeof data === 'object' ? JSON.stringify(data) : data);
}

async function getAccessToken() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      'Missing Google OAuth env vars: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_OAUTH_REFRESH_TOKEN'
    );
  }

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google OAuth refresh failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  return data.access_token;
}

async function searchEvents(accessToken, query, timeMin, timeMax) {
  // Use the primary calendar. We could iterate all calendars, but for v1
  // primary covers 95% of business meeting context.
  const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
  url.searchParams.set('q', query);                  // full-text search across attendees, summary, etc.
  url.searchParams.set('timeMin', timeMin);
  url.searchParams.set('timeMax', timeMax);
  url.searchParams.set('singleEvents', 'true');
  url.searchParams.set('orderBy', 'startTime');
  url.searchParams.set('maxResults', '25');

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Calendar API ${res.status}: ${text}`);
  }
  const data = await res.json();
  return data.items || [];
}

function shapeEvent(e) {
  return {
    id: e.id,
    summary: e.summary,
    description: e.description?.slice(0, 300),
    start: e.start?.dateTime || e.start?.date,
    end: e.end?.dateTime || e.end?.date,
    status: e.status,
    attendees: (e.attendees || []).map(a => ({
      email: a.email,
      name: a.displayName,
      response: a.responseStatus,
    })),
    location: e.location,
    hangoutLink: e.hangoutLink,
    htmlLink: e.htmlLink,
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  try {
    const { email, name } = req.body || {};
    if (!email && !name) {
      return res.status(400).json({ error: "Provide 'email' or 'name'" });
    }

    log('QUERY', { email, name });

    const accessToken = await getAccessToken();

    // Search by email if provided, fall back to name
    const query = email || name;

    // Window: 180 days back, 60 days forward
    const now = new Date();
    const past = new Date(now);
    past.setDate(past.getDate() - 180);
    const future = new Date(now);
    future.setDate(future.getDate() + 60);

    const events = await searchEvents(
      accessToken,
      query,
      past.toISOString(),
      future.toISOString()
    );

    // Filter: must actually involve the person (email match in attendees)
    const filtered = email
      ? events.filter(e =>
          (e.attendees || []).some(a => a.email?.toLowerCase() === email.toLowerCase())
        )
      : events;

    const shaped = filtered.map(shapeEvent);
    const pastEvents = shaped.filter(e => new Date(e.start) < now);
    const upcomingEvents = shaped.filter(e => new Date(e.start) >= now);

    log('RESULT', `past=${pastEvents.length} upcoming=${upcomingEvents.length}`);

    return res.status(200).json({
      status: 'ok',
      query: { email, name },
      past: pastEvents,
      upcoming: upcomingEvents,
    });
  } catch (err) {
    log('ERROR', err.message);
    return res.status(500).json({ error: err.message });
  }
}
