import express from "express";
import { google } from "googleapis";
import { DateTime, Interval } from "luxon";

const app = express();

/**
 * Twilio sends application/x-www-form-urlencoded
 * Retell function calls send JSON
 */
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: "2mb" }));

// =====================
// ENV CONFIG
// =====================
const {
  // Recommended (Render env vars)
  GOOGLE_CLIENT_EMAIL,
  GOOGLE_PRIVATE_KEY,

  // Optional fallback (full JSON blob)
  GOOGLE_SERVICE_ACCOUNT_JSON,

  GCAL_ID = "primary",
  SHEET_ID,
  SHEET_TAB = "Bookings",

  // Use an ET zone, but never *say* "Detroit" in prompts.
  DEFAULT_TIMEZONE = "America/New_York",

  MIN_LEAD_MINUTES = "120",
  DEMO_DURATION_MINUTES = "30",
  SLOT_GRANULARITY_MINUTES = "30",
  SEARCH_DAYS = "14",
  WORK_START_HOUR = "9",
  WORK_END_HOUR = "17",

  RETELL_AGENT_ID
} = process.env;

if (!SHEET_ID) throw new Error("Missing SHEET_ID");
if (!RETELL_AGENT_ID) throw new Error("Missing RETELL_AGENT_ID");

// =====================
// GOOGLE AUTH
// =====================
function normalizePrivateKey(raw) {
  if (!raw) return "";
  // Convert literal "\n" sequences into real newlines
  let k = raw.replace(/\\n/g, "\n");
  // Normalize Windows line endings just in case
  k = k.replace(/\r\n/g, "\n").trim();
  return k;
}

function getGoogleCreds() {
  // Prefer split env vars
  if (GOOGLE_CLIENT_EMAIL && GOOGLE_PRIVATE_KEY) {
    return {
      client_email: GOOGLE_CLIENT_EMAIL.trim(),
      private_key: normalizePrivateKey(GOOGLE_PRIVATE_KEY)
    };
  }

  // Fallback to full JSON env var
  if (GOOGLE_SERVICE_ACCOUNT_JSON) {
    const parsed = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
    return {
      client_email: (parsed.client_email || "").trim(),
      private_key: normalizePrivateKey(parsed.private_key || "")
    };
  }

  throw new Error(
    "Missing Google credentials. Provide GOOGLE_CLIENT_EMAIL + GOOGLE_PRIVATE_KEY (recommended) OR GOOGLE_SERVICE_ACCOUNT_JSON."
  );
}

function getGoogleClients() {
  const { client_email, private_key } = getGoogleCreds();
  if (!client_email) throw new Error("Missing client_email in Google creds");
  if (!private_key) throw new Error("Missing private_key in Google creds");

  const auth = new google.auth.JWT(
    client_email,
    undefined,
    private_key,
    [
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/spreadsheets"
    ]
  );

  return {
    calendar: google.calendar({ version: "v3", auth }),
    sheets: google.sheets({ version: "v4", auth })
  };
}

// =====================
// TIME / SLOT HELPERS
// =====================
function isWeekday(dt) {
  return dt.weekday >= 1 && dt.weekday <= 5;
}

function buildCandidateSlots(nowLocal) {
  const lead = Number(MIN_LEAD_MINUTES);
  const duration = Number(DEMO_DURATION_MINUTES);
  const step = Number(SLOT_GRANULARITY_MINUTES);
  const days = Number(SEARCH_DAYS);
  const startHour = Number(WORK_START_HOUR);
  const endHour = Number(WORK_END_HOUR);

  const earliest = nowLocal.plus({ minutes: lead });
  const slots = [];

  for (let d = 0; d < days; d++) {
    const day = earliest.startOf("day").plus({ days: d });
    if (!isWeekday(day)) continue;

    let cursor = day.set({ hour: startHour, minute: 0, second: 0, millisecond: 0 });
    const end = day.set({ hour: endHour, minute: 0, second: 0, millisecond: 0 });

    while (cursor.plus({ minutes: duration }) <= end) {
      if (cursor >= earliest) {
        slots.push({ start: cursor, end: cursor.plus({ minutes: duration }) });
      }
      cursor = cursor.plus({ minutes: step });
    }
  }

  return slots;
}

function slotIsFree(slot, busyIntervals) {
  const slotInterval = Interval.fromDateTimes(slot.start, slot.end);
  return !busyIntervals.some((b) => slotInterval.overlaps(b));
}

async function getBusyIntervals(calendar, timeMinISO, timeMaxISO) {
  const fb = await calendar.freebusy.query({
    requestBody: {
      timeMin: timeMinISO,
      timeMax: timeMaxISO,
      items: [{ id: GCAL_ID }]
    }
  });

  const busy = (fb.data.calendars?.[GCAL_ID]?.busy || []).map((b) =>
    Interval.fromDateTimes(DateTime.fromISO(b.start), DateTime.fromISO(b.end))
  );

  return busy;
}

function formatSlotLabel(dtStart, dtEnd) {
  // Example: "Tue, Feb 11 at 2:00 PM–2:30 PM ET"
  const day = dtStart.toFormat("ccc, LLL d");
  const start = dtStart.toFormat("h:mm a");
  const end = dtEnd.toFormat("h:mm a");
  return `${day} at ${start}–${end} ET`;
}

function pickFirstNFreeSlots(candidates, busyIntervals, n = 2) {
  const free = [];
  for (const s of candidates) {
    if (slotIsFree(s, busyIntervals)) {
      free.push(s);
      if (free.length >= n) break;
    }
  }
  return free;
}

// Build a focused search window around a requested time, then return nearby free slots
async function findNearbyFreeSlots(calendar, preferredStartLocal, count = 2) {
  const duration = Number(DEMO_DURATION_MINUTES);
  const step = Number(SLOT_GRANULARITY_MINUTES);
  const startHour = Number(WORK_START_HOUR);
  const endHour = Number(WORK_END_HOUR);

  // Search same day first, then next weekday if needed (up to 5 days)
  const daysToTry = 5;
  const allCandidates = [];

  for (let i = 0; i < daysToTry; i++) {
    const day = preferredStartLocal.startOf("day").plus({ days: i });
    if (!isWeekday(day)) continue;

    let cursor = day.set({ hour: startHour, minute: 0, second: 0, millisecond: 0 });
    const end = day.set({ hour: endHour, minute: 0, second: 0, millisecond: 0 });

    while (cursor.plus({ minutes: duration }) <= end) {
      allCandidates.push({ start: cursor, end: cursor.plus({ minutes: duration }) });
      cursor = cursor.plus({ minutes: step });
    }
  }

  // Busy window: cover whole candidate range
  if (!allCandidates.length) return [];
  const busy = await getBusyIntervals(
    calendar,
    allCandidates[0].start.toUTC().toISO(),
    allCandidates[allCandidates.length - 1].end.toUTC().toISO()
  );

  // Sort candidates by distance from preferred time (absolute minutes), then pick first free
  const sorted = allCandidates
    .map((s) => ({
      ...s,
      dist: Math.abs(s.start.diff(preferredStartLocal, "minutes").minutes)
    }))
    .sort((a, b) => a.dist - b.dist)
    .map(({ dist, ...slot }) => slot);

  const free = [];
  for (const s of sorted) {
    if (slotIsFree(s, busy)) {
      // Avoid returning the exact same slot twice
      if (!free.some((x) => x.start.toISO() === s.start.toISO())) free.push(s);
      if (free.length >= count) break;
    }
  }
  return free;
}

// =====================
// REQUEST PARSING (Retell)
// =====================
function extractArgs(req) {
  return req.body?.args ?? req.body?.arguments ?? req.body ?? {};
}

// =====================
// HEALTH
// =====================
app.get("/", (req, res) => res.json({ ok: true }));
app.get("/health", (req, res) => res.json({ ok: true }));

// =====================
// RETELL: GET NEXT SLOTS (2 by default)
// =====================
app.post("/retell/get_slots", async (req, res) => {
  try {
    const args = extractArgs(req);
    const count = Number(args.count ?? 2);

    const { calendar } = getGoogleClients();
    const nowLocal = DateTime.now().setZone(DEFAULT_TIMEZONE);

    const candidates = buildCandidateSlots(nowLocal);
    if (!candidates.length) {
      return res.json({ status: "no_slots", slots: [] });
    }

    const busy = await getBusyIntervals(
      calendar,
      candidates[0].start.toUTC().toISO(),
      candidates[candidates.length - 1].end.toUTC().toISO()
    );

    const free = pickFirstNFreeSlots(candidates, busy, count);

    return res.json({
      status: free.length ? "ok" : "no_slots",
      slots: free.map((s) => ({
        start_time: s.start.toISO(),
        end_time: s.end.toISO(),
        label: formatSlotLabel(s.start, s.end)
      }))
    });
  } catch (err) {
    console.error("GET_SLOTS ERROR:", err);
    return res.status(500).json({ status: "error", message: err?.message || "Internal server error" });
  }
});

// =====================
// RETELL: CHECK AVAILABILITY FOR A REQUESTED SLOT
// =====================
app.post("/retell/check_availability", async (req, res) => {
  try {
    const args = extractArgs(req);
    const start_time = args.start_time ?? args.preferred_datetime ?? args.preferred_time;

    if (!start_time) {
      return res.status(400).json({
        status: "error",
        message: "Missing start_time (ISO 8601 in ET), e.g. 2026-02-11T14:00:00-05:00"
      });
    }

    const duration = Number(DEMO_DURATION_MINUTES);
    const start = DateTime.fromISO(start_time, { setZone: true }).setZone(DEFAULT_TIMEZONE);
    if (!start.isValid) {
      return res.status(400).json({ status: "error", message: "Invalid start_time ISO format" });
    }

    const end = start.plus({ minutes: duration });

    const { calendar } = getGoogleClients();
    const busy = await getBusyIntervals(calendar, start.toUTC().toISO(), end.toUTC().toISO());

    const requested = { start, end };
    const available = slotIsFree(requested, busy);

    return res.json({
      status: "ok",
      available,
      start_time: start.toISO(),
      end_time: end.toISO(),
      label: formatSlotLabel(start, end)
    });
  } catch (err) {
    console.error("CHECK_AVAILABILITY ERROR:", err);
    return res.status(500).json({ status: "error", message: err?.message || "Internal server error" });
  }
});

// =====================
// RETELL: GET 1–2 NEARBY SLOTS
// =====================
app.post("/retell/get_nearby_slots", async (req, res) => {
  try {
    const args = extractArgs(req);
    const start_time = args.start_time ?? args.preferred_datetime ?? args.preferred_time;
    const count = Number(args.count ?? 2);

    if (!start_time) {
      return res.status(400).json({
        status: "error",
        message: "Missing start_time (ISO 8601 in ET), e.g. 2026-02-11T14:00:00-05:00"
      });
    }

    const preferred = DateTime.fromISO(start_time, { setZone: true }).setZone(DEFAULT_TIMEZONE);
    if (!preferred.isValid) {
      return res.status(400).json({ status: "error", message: "Invalid start_time ISO format" });
    }

    const { calendar } = getGoogleClients();
    const free = await findNearbyFreeSlots(calendar, preferred, count);

    return res.json({
      status: free.length ? "ok" : "no_slots",
      slots: free.map((s) => ({
        start_time: s.start.toISO(),
        end_time: s.end.toISO(),
        label: formatSlotLabel(s.start, s.end)
      }))
    });
  } catch (err) {
    console.error("GET_NEARBY_SLOTS ERROR:", err);
    return res.status(500).json({ status: "error", message: err?.message || "Internal server error" });
  }
});

// =====================
// RETELL: BOOK DEMO (caller chooses start_time)
// =====================
app.post("/retell/book_demo", async (req, res) => {
  try {
    const payload = extractArgs(req);

    const {
      full_name,
      email,
      phone,
      business_type = "",
      notes = "",
      start_time
    } = payload;

    const missing = [];
    if (!full_name) missing.push("full_name");
    if (!email) missing.push("email");
    if (!phone) missing.push("phone");
    if (!business_type) missing.push("business_type");
    if (!start_time) missing.push("start_time");

    if (missing.length) {
      return res.status(400).json({
        status: "error",
        message: "Missing required fields",
        missing
      });
    }

    const duration = Number(DEMO_DURATION_MINUTES);
    const start = DateTime.fromISO(start_time, { setZone: true }).setZone(DEFAULT_TIMEZONE);
    if (!start.isValid) {
      return res.status(400).json({ status: "error", message: "Invalid start_time ISO format" });
    }
    const end = start.plus({ minutes: duration });

    const { calendar, sheets } = getGoogleClients();

    // Confirm requested slot is free right now
    const busy = await getBusyIntervals(calendar, start.toUTC().toISO(), end.toUTC().toISO());
    const requested = { start, end };

    if (!slotIsFree(requested, busy)) {
      const alternatives = await findNearbyFreeSlots(calendar, start, 2);
      return res.json({
        status: "unavailable",
        message: "That time is taken.",
        requested: {
          start_time: start.toISO(),
          end_time: end.toISO(),
          label: formatSlotLabel(start, end)
        },
        alternatives: alternatives.map((s) => ({
          start_time: s.start.toISO(),
          end_time: s.end.toISO(),
          label: formatSlotLabel(s.start, s.end)
        }))
      });
    }

    // IMPORTANT:
    // - No attendees (avoids "Service accounts cannot invite attendees..." error)
    // - No conferenceData (avoids "Invalid conference type value" issues)
    const event = await calendar.events.insert({
      calendarId: GCAL_ID,
      sendUpdates: "none",
      requestBody: {
        summary: `MK Receptions Demo – ${full_name}`,
        description:
          `Name: ${full_name}\n` +
          `Email: ${email}\n` +
          `Phone: ${phone}\n` +
          `Business: ${business_type}\n` +
          (notes ? `Notes: ${notes}\n` : ""),
        start: { dateTime: start.toISO(), timeZone: DEFAULT_TIMEZONE },
        end: { dateTime: end.toISO(), timeZone: DEFAULT_TIMEZONE }
      }
    });

    const calendarLink = event.data.htmlLink || "";
    const eventId = event.data.id || "";

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB}!A:Z`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[
          new Date().toISOString(),
          full_name,
          email,
          phone,
          business_type,
          start.toISO(),
          end.toISO(),
          calendarLink,
          eventId
        ]]
      }
    });

    return res.json({
      status: "confirmed",
      start_time: start.toISO(),
      end_time: end.toISO(),
      calendar_link: calendarLink
    });
  } catch (err) {
    console.error("BOOK_DEMO ERROR:", err);
    return res.status(500).json({
      status: "error",
      message: err?.message || "Internal server error"
    });
  }
});

// =====================
// TWILIO → RETELL STREAM
// =====================
function twimlStreamResponse(agentId) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://api.retellai.com/audio-stream">
      <Parameter name="agent_id" value="${agentId}" />
    </Stream>
  </Connect>
</Response>`;
}

app.post("/twilio/voice", (req, res) => {
  res.type("text/xml");
  res.send(twimlStreamResponse(RETELL_AGENT_ID));
});

app.get("/twilio/voice", (req, res) => {
  res.type("text/xml");
  res.send(twimlStreamResponse(RETELL_AGENT_ID));
});

// =====================
// START SERVER
// =====================
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));

app.listen(port, () => console.log(`Server running on port ${port}`));
