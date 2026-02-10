// =====================
// BOOK DEMO (COPY/PASTE ROUTE ONLY)
// =====================
app.post("/retell/book_demo", async (req, res) => {
  try {
    const payload = extractArgs(req);

    const {
      full_name,
      email,
      phone,
      business_type,
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

    const { calendar, sheets } = getGoogleClients();

    // Validate time (blocks wrong year like 2024, out-of-window, weekends, etc.)
    const validation = validateRequestedStart(start_time);
    if (!validation.ok) {
      const alternatives = await getNextAvailableSlots(calendar, 2);
      return res.json({
        status: "invalid_time",
        message: validation.message,
        alternatives
      });
    }

    const start = validation.start;
    const end = start.plus({ minutes: Number(DEMO_DURATION_MINUTES) });

    // Check busy for requested slot
    const busy = await getBusyIntervals(calendar, start.toUTC().toISO(), end.toUTC().toISO());
    if (!slotIsFree({ start, end }, busy)) {
      const nearby = await findNearbyFreeSlots(calendar, start, 2);
      return res.json({
        status: "unavailable",
        message: "That time is taken.",
        requested: {
          start_time: start.toISO(),
          end_time: end.toISO(),
          label: formatSlotLabel(start, end)
        },
        alternatives: nearby
      });
    }

    // Create event (NO attendees / NO meet link)
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
// FULL server.js (COPY/PASTE ENTIRE FILE)
// =====================
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
  GOOGLE_CLIENT_EMAIL,
  GOOGLE_PRIVATE_KEY,
  GOOGLE_SERVICE_ACCOUNT_JSON,

  GCAL_ID = "primary",
  SHEET_ID,
  SHEET_TAB = "Bookings",

  DEFAULT_TIMEZONE = "America/New_York",

  MIN_LEAD_MINUTES = "120",
  DEMO_DURATION_MINUTES = "30",
  SLOT_GRANULARITY_MINUTES = "30",
  SEARCH_DAYS = "14",

  // Set these on Render to enforce your window:
  // WORK_START_HOUR=12
  // WORK_END_HOUR=21
  WORK_START_HOUR = "12",
  WORK_END_HOUR = "21",

  RETELL_AGENT_ID
} = process.env;

if (!SHEET_ID) throw new Error("Missing SHEET_ID");
if (!RETELL_AGENT_ID) throw new Error("Missing RETELL_AGENT_ID");

// =====================
// GOOGLE AUTH
// =====================
function normalizePrivateKey(raw) {
  if (!raw) return "";
  return raw.replace(/\\n/g, "\n").replace(/\r\n/g, "\n").trim();
}

function getGoogleCreds() {
  if (GOOGLE_CLIENT_EMAIL && GOOGLE_PRIVATE_KEY) {
    return {
      client_email: GOOGLE_CLIENT_EMAIL.trim(),
      private_key: normalizePrivateKey(GOOGLE_PRIVATE_KEY)
    };
  }

  if (GOOGLE_SERVICE_ACCOUNT_JSON) {
    const parsed = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
    return {
      client_email: (parsed.client_email || "").trim(),
      private_key: normalizePrivateKey(parsed.private_key || "")
    };
  }

  throw new Error(
    "Missing Google credentials. Provide GOOGLE_CLIENT_EMAIL + GOOGLE_PRIVATE_KEY OR GOOGLE_SERVICE_ACCOUNT_JSON."
  );
}

function getGoogleClients() {
  const { client_email, private_key } = getGoogleCreds();
  if (!client_email) throw new Error("Missing Google client_email");
  if (!private_key) throw new Error("Missing Google private_key");

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
// UTILS
// =====================
function extractArgs(req) {
  return req.body?.args ?? req.body?.arguments ?? req.body ?? {};
}

function isWeekday(dt) {
  return dt.weekday >= 1 && dt.weekday <= 5;
}

function formatSlotLabel(dtStart, dtEnd) {
  const day = dtStart.toFormat("ccc, LLL d");
  const start = dtStart.toFormat("h:mm a");
  const end = dtEnd.toFormat("h:mm a");
  return `${day} at ${start}–${end} ET`;
}

function slotIsFree(slot, busyIntervals) {
  const slotInterval = Interval.fromDateTimes(slot.start, slot.end);
  return !busyIntervals.some(b => slotInterval.overlaps(b));
}

async function getBusyIntervals(calendar, timeMinISO, timeMaxISO) {
  const fb = await calendar.freebusy.query({
    requestBody: {
      timeMin: timeMinISO,
      timeMax: timeMaxISO,
      items: [{ id: GCAL_ID }]
    }
  });

  return (fb.data.calendars?.[GCAL_ID]?.busy || []).map(b =>
    Interval.fromDateTimes(DateTime.fromISO(b.start), DateTime.fromISO(b.end))
  );
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

// HARD VALIDATION to stop “2024” or any past booking instantly
function validateRequestedStart(startTimeISO) {
  if (!startTimeISO) {
    return { ok: false, message: "Missing start_time." };
  }

  const start = DateTime.fromISO(startTimeISO, { setZone: true }).setZone(DEFAULT_TIMEZONE);
  if (!start.isValid) {
    return { ok: false, message: "Invalid start_time format. Use ISO 8601 in ET." };
  }

  const now = DateTime.now().setZone(DEFAULT_TIMEZONE);
  const lead = Number(MIN_LEAD_MINUTES);

  // Block past / too-soon (fixes wrong year like 2024 automatically)
  if (start < now.plus({ minutes: lead })) {
    return { ok: false, message: "That time is in the past or too soon. Please choose a future time." };
  }

  // Weekdays only
  if (!isWeekday(start)) {
    return { ok: false, message: "Demos are Monday through Friday only." };
  }

  // Window enforcement (12pm–9pm ET)
  const startHour = Number(WORK_START_HOUR);
  const endHour = Number(WORK_END_HOUR);
  const end = start.plus({ minutes: Number(DEMO_DURATION_MINUTES) });

  const dayStart = start.startOf("day").set({ hour: startHour, minute: 0 });
  const dayEnd = start.startOf("day").set({ hour: endHour, minute: 0 });

  if (start < dayStart || end > dayEnd) {
    return { ok: false, message: `Demos can only be booked between ${startHour}:00 and ${endHour}:00 ET.` };
  }

  // Optional: enforce granularity (30-min steps)
  const step = Number(SLOT_GRANULARITY_MINUTES);
  if (start.minute % step !== 0) {
    return { ok: false, message: `Please choose a time on a ${step}-minute boundary (e.g., 12:00, 12:30, 1:00).` };
  }

  return { ok: true, start };
}

async function getNextAvailableSlots(calendar, count = 2) {
  const now = DateTime.now().setZone(DEFAULT_TIMEZONE);
  const candidates = buildCandidateSlots(now);
  if (!candidates.length) return [];

  const busy = await getBusyIntervals(
    calendar,
    candidates[0].start.toUTC().toISO(),
    candidates[candidates.length - 1].end.toUTC().toISO()
  );

  const free = [];
  for (const s of candidates) {
    if (slotIsFree(s, busy)) {
      free.push({
        start_time: s.start.toISO(),
        end_time: s.end.toISO(),
        label: formatSlotLabel(s.start, s.end)
      });
      if (free.length >= count) break;
    }
  }
  return free;
}

async function findNearbyFreeSlots(calendar, preferredStartLocal, count = 2) {
  const duration = Number(DEMO_DURATION_MINUTES);
  const step = Number(SLOT_GRANULARITY_MINUTES);
  const startHour = Number(WORK_START_HOUR);
  const endHour = Number(WORK_END_HOUR);

  const candidates = [];
  for (let i = 0; i < 5; i++) {
    const day = preferredStartLocal.startOf("day").plus({ days: i });
    if (!isWeekday(day)) continue;

    let cursor = day.set({ hour: startHour, minute: 0, second: 0, millisecond: 0 });
    const end = day.set({ hour: endHour, minute: 0, second: 0, millisecond: 0 });

    while (cursor.plus({ minutes: duration }) <= end) {
      candidates.push({ start: cursor, end: cursor.plus({ minutes: duration }) });
      cursor = cursor.plus({ minutes: step });
    }
  }

  if (!candidates.length) return [];

  const busy = await getBusyIntervals(
    calendar,
    candidates[0].start.toUTC().toISO(),
    candidates[candidates.length - 1].end.toUTC().toISO()
  );

  const sorted = candidates
    .map(s => ({
      ...s,
      distMs: Math.abs(s.start.toMillis() - preferredStartLocal.toMillis())
    }))
    .sort((a, b) => a.distMs - b.distMs);

  const out = [];
  for (const s of sorted) {
    if (slotIsFree(s, busy)) {
      const item = {
        start_time: s.start.toISO(),
        end_time: s.end.toISO(),
        label: formatSlotLabel(s.start, s.end)
      };
      if (!out.some(x => x.start_time === item.start_time)) out.push(item);
      if (out.length >= count) break;
    }
  }

  return out;
}

// =====================
// HEALTH
// =====================
app.get("/", (req, res) => res.json({ ok: true }));
app.get("/health", (req, res) => res.json({ ok: true }));

// =====================
// RETELL: GET SLOTS
// =====================
app.post("/retell/get_slots", async (req, res) => {
  try {
    const args = extractArgs(req);
    const count = Number(args.count ?? 2);

    const { calendar } = getGoogleClients();
    const slots = await getNextAvailableSlots(calendar, count);

    return res.json({
      status: slots.length ? "ok" : "no_slots",
      slots
    });
  } catch (err) {
    console.error("GET_SLOTS ERROR:", err);
    return res.status(500).json({ status: "error", message: err?.message || "Internal server error" });
  }
});

// =====================
// RETELL: CHECK AVAILABILITY
// =====================
app.post("/retell/check_availability", async (req, res) => {
  try {
    const args = extractArgs(req);
    const start_time = args.start_time;

    const { calendar } = getGoogleClients();

    const validation = validateRequestedStart(start_time);
    if (!validation.ok) {
      return res.json({
        status: "invalid_time",
        available: false,
        message: validation.message,
        alternatives: await getNextAvailableSlots(calendar, 2)
      });
    }

    const start = validation.start;
    const end = start.plus({ minutes: Number(DEMO_DURATION_MINUTES) });

    const busy = await getBusyIntervals(calendar, start.toUTC().toISO(), end.toUTC().toISO());
    const available = slotIsFree({ start, end }, busy);

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
// RETELL: GET NEARBY SLOTS
// =====================
app.post("/retell/get_nearby_slots", async (req, res) => {
  try {
    const args = extractArgs(req);
    const start_time = args.start_time;
    const count = Number(args.count ?? 2);

    const { calendar } = getGoogleClients();

    const validation = validateRequestedStart(start_time);
    if (!validation.ok) {
      return res.json({
        status: "invalid_time",
        message: validation.message,
        slots: await getNextAvailableSlots(calendar, count)
      });
    }

    const preferred = validation.start;
    const slots = await findNearbyFreeSlots(calendar, preferred, count);

    return res.json({
      status: slots.length ? "ok" : "no_slots",
      slots
    });
  } catch (err) {
    console.error("GET_NEARBY_SLOTS ERROR:", err);
    return res.status(500).json({ status: "error", message: err?.message || "Internal server error" });
  }
});

// =====================
// RETELL: BOOK DEMO
// =====================
app.post("/retell/book_demo", async (req, res) => {
  try {
    const payload = extractArgs(req);

    const {
      full_name,
      email,
      phone,
      business_type,
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

    const { calendar, sheets } = getGoogleClients();

    const validation = validateRequestedStart(start_time);
    if (!validation.ok) {
      const alternatives = await getNextAvailableSlots(calendar, 2);
      return res.json({
        status: "invalid_time",
        message: validation.message,
        alternatives
      });
    }

    const start = validation.start;
    const end = start.plus({ minutes: Number(DEMO_DURATION_MINUTES) });

    const busy = await getBusyIntervals(calendar, start.toUTC().toISO(), end.toUTC().toISO());
    if (!slotIsFree({ start, end }, busy)) {
      const nearby = await findNearbyFreeSlots(calendar, start, 2);
      return res.json({
        status: "unavailable",
        message: "That time is taken.",
        requested: {
          start_time: start.toISO(),
          end_time: end.toISO(),
          label: formatSlotLabel(start, end)
        },
        alternatives: nearby
      });
    }

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

// Helpful for browser testing
app.get("/twilio/voice", (req, res) => {
  res.type("text/xml");
  res.send(twimlStreamResponse(RETELL_AGENT_ID));
});

// =====================
// START SERVER (ONLY ONE LISTEN)
// =====================
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
