// /api/ghl-contact-lookup.js
//
// GoHighLevel Contact 360 lookup.
// Takes a name or email, returns either:
//   - Multiple matches (for disambiguation), OR
//   - Full fan-out: contact + tags + opportunities + notes + tasks + conversations
//
// READ-ONLY. No writes. No side effects.
//
// Usage: POST /api/ghl-contact-lookup
// Body: { "query": "john doe" }  OR  { "query": "john@example.com" }  OR  { "contactId": "abc123" }

const GHL_BASE = "https://services.leadconnectorhq.com";

// ---------- helpers ----------

function ghlHeaders() {
  return {
    Authorization: `Bearer ${process.env.GHL_PIT_TOKEN}`,
    Version: process.env.GHL_API_VERSION || "2021-07-28",
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

async function ghlGet(path, params = {}) {
  const url = new URL(`${GHL_BASE}${path}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.append(k, v);
  });
  const res = await fetch(url.toString(), { headers: ghlHeaders() });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GHL ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

async function ghlPost(path, body) {
  const res = await fetch(`${GHL_BASE}${path}`, {
    method: "POST",
    headers: ghlHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GHL POST ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

// ---------- search ----------

async function searchContacts(query) {
  const locationId = process.env.GHL_LOCATION_ID;
  const isEmail = /@/.test(query);

  // v2 contact search endpoint
  const body = {
    locationId,
    pageLimit: 10,
    filters: [
      {
        field: isEmail ? "email" : "name",
        operator: isEmail ? "eq" : "contains",
        value: query,
      },
    ],
  };

  const data = await ghlPost("/contacts/search", body);
  return data.contacts || [];
}

// ---------- fan-out ----------

async function getContact(contactId) {
  const data = await ghlGet(`/contacts/${contactId}`);
  return data.contact || data;
}

async function getOpportunities(contactId) {
  const locationId = process.env.GHL_LOCATION_ID;
  try {
    const data = await ghlGet("/opportunities/search", {
      location_id: locationId,
      contact_id: contactId,
      limit: 25,
    });
    return data.opportunities || [];
  } catch (e) {
    return { error: e.message };
  }
}

async function getTasks(contactId) {
  try {
    const data = await ghlGet(`/contacts/${contactId}/tasks`);
    return data.tasks || [];
  } catch (e) {
    return { error: e.message };
  }
}

async function getNotes(contactId) {
  try {
    const data = await ghlGet(`/contacts/${contactId}/notes`);
    return data.notes || [];
  } catch (e) {
    return { error: e.message };
  }
}

async function getConversations(contactId) {
  const locationId = process.env.GHL_LOCATION_ID;
  try {
    const data = await ghlGet("/conversations/search", {
      locationId,
      contactId,
      limit: 20,
    });
    return data.conversations || [];
  } catch (e) {
    return { error: e.message };
  }
}

async function getConversationMessages(conversationId, limit = 20) {
  try {
    const data = await ghlGet(`/conversations/${conversationId}/messages`, {
      limit,
    });
    return data.messages?.messages || data.messages || [];
  } catch (e) {
    return { error: e.message };
  }
}

// ---------- shaping ----------

function shapeContact(c) {
  return {
    id: c.id,
    name:
      c.contactName ||
      [c.firstName, c.lastName].filter(Boolean).join(" ").trim() ||
      "(no name)",
    firstName: c.firstName,
    lastName: c.lastName,
    email: c.email,
    phone: c.phone,
    companyName: c.companyName,
    source: c.source,
    tags: c.tags || [],
    dateAdded: c.dateAdded,
    dateUpdated: c.dateUpdated,
    type: c.type,
    assignedTo: c.assignedTo,
  };
}

function shapeOpportunity(o) {
  return {
    id: o.id,
    name: o.name,
    pipelineId: o.pipelineId,
    pipelineStageId: o.pipelineStageId,
    status: o.status,
    monetaryValue: o.monetaryValue,
    assignedTo: o.assignedTo,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    lastStatusChangeAt: o.lastStatusChangeAt,
    lastStageChangeAt: o.lastStageChangeAt,
  };
}

function shapeNote(n) {
  return {
    id: n.id,
    body: n.body,
    createdBy: n.createdBy || n.userId,
    dateAdded: n.dateAdded || n.createdAt,
  };
}

function shapeTask(t) {
  return {
    id: t.id,
    title: t.title,
    body: t.body,
    completed: t.completed,
    dueDate: t.dueDate,
    assignedTo: t.assignedTo,
  };
}

function shapeConversation(c) {
  return {
    id: c.id,
    type: c.type,
    unreadCount: c.unreadCount,
    lastMessageBody: c.lastMessageBody,
    lastMessageType: c.lastMessageType,
    lastMessageDate: c.lastMessageDate,
    lastMessageDirection: c.lastMessageDirection,
  };
}

// ---------- handler ----------

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  // env sanity
  const missing = ["GHL_PIT_TOKEN", "GHL_LOCATION_ID"].filter(
    (k) => !process.env[k]
  );
  if (missing.length) {
    return res
      .status(500)
      .json({ error: `Missing env vars: ${missing.join(", ")}` });
  }

  try {
    const { query, contactId, includeMessages = false } = req.body || {};

    if (!query && !contactId) {
      return res
        .status(400)
        .json({ error: "Provide 'query' (name/email) or 'contactId'" });
    }

    // Resolve to a contact ID
    let resolvedId = contactId;
    if (!resolvedId) {
      const matches = await searchContacts(query);

      if (matches.length === 0) {
        return res.status(200).json({
          status: "no_match",
          query,
          matches: [],
        });
      }

      if (matches.length > 1) {
        return res.status(200).json({
          status: "multiple_matches",
          query,
          matches: matches.map(shapeContact),
        });
      }

      resolvedId = matches[0].id;
    }

    // Single match → fan out in parallel
    const [contact, opportunities, notes, tasks, conversations] =
      await Promise.all([
        getContact(resolvedId),
        getOpportunities(resolvedId),
        getNotes(resolvedId),
        getTasks(resolvedId),
        getConversations(resolvedId),
      ]);

    // Optionally pull messages for the most recent conversation
    let recentMessages = null;
    if (includeMessages && Array.isArray(conversations) && conversations[0]) {
      recentMessages = await getConversationMessages(conversations[0].id, 20);
    }

    return res.status(200).json({
      status: "ok",
      contact: shapeContact(contact),
      opportunities: Array.isArray(opportunities)
        ? opportunities.map(shapeOpportunity)
        : opportunities,
      notes: Array.isArray(notes) ? notes.map(shapeNote) : notes,
      tasks: Array.isArray(tasks) ? tasks.map(shapeTask) : tasks,
      conversations: Array.isArray(conversations)
        ? conversations.map(shapeConversation)
        : conversations,
      recentMessages,
    });
  } catch (err) {
    console.error("[ghl-contact-lookup]", err);
    return res.status(500).json({ error: err.message });
  }
}
