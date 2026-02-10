import express from "express";
import { google } from "googleapis";
import { DateTime, Interval } from "luxon";

const app = express();

/**
 * Twilio sends application/x-www-form-urlencoded
 * Retell tool calls send JSON
 */
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: "2mb" }));

// =====================
// ENV CONFIG
// =====================
const {
  GOOGLE_SERVICE_ACCOUNT_JSON,

  // Calendar + Sheets
  GCAL_ID = "primary",
  SHEET_ID,
  SHEET_TAB = "Bookings",

  // Scheduling rules
  DEFAULT_TIMEZONE = "America/New_York", // Use ET
  MIN_LEAD_MINUTES = "120",
  DEMO_DURATION_MINUTES = "30",
  SLOT_GRANULARITY_MINUTES = "30",
  SEARCH_DAYS = "14",
  WORK_START_HOUR = "9",
  WORK_END_HOUR = "17",

  // Twilio → Retell audio stream
  RETELL_AGENT_ID
} = process.env;

if (!GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_JSON");
if (!SHEET_ID) throw new Error("Missing SHEET_ID");
if (!RETELL_AGENT_ID) throw new Error("Missing RETELL_AGENT_ID");

// =====================
// GOOGLE CLIENTS
// =====================
function getGoogleClients() {
  const key = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);

  const auth = new google.auth.JWT(
    key.client_email,
    undefined,
    key.private_key.replace(/\\n/g, "\n"),
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

function withinWorkHours(startLocal, endLocal) {
  const startHour = Number(WORK_START_HOUR);
  const endHour = Number(WORK_END_HOUR);

  const dayStart = startLocal.startOf("day").set({ hour: startHour, minute: 0, second: 0, millisecond: 0 });
  const dayEnd = startLocal.startOf("day").set({ hour: endHour, minute: 0, second: 0, millisecond: 0 });

  return startLocal >= dayStart && endLocal <= dayEnd;
}

function roundUpToGranularity(dt) {
  const step = Number(SLOT_GRANULARITY_MINUTES);
  const minutes = dt.minute;
  const rounded = Math.ceil(minutes / step) * step;
  return dt.set({ minute: 0, second: 0, millisecond: 0 }).plus({ minutes: rounded });
}

async function getBusyIntervals(calendar, timeMinISO, timeMaxISO) {
  const fb = await calendar.freebusy.query({
    requestBody: {
      timeMin: timeMinISO,
      timeMax: timeMaxISO,
      items: [{ id: GCAL_ID }]
    }
  });

  const busy = (fb.data.calendars?.[GCAL_ID]?.busy || []).map(b =>
    Interval.fromDateTimes(DateTime.fromISO(b.start), DateTime.fromISO(b.end))
  );

  return busy;
}

function slotIsFree(slot, busyIntervals) {
  const slotInterval = Interval.fromDateTimes(slot.start, slot.end);
  return !busyIntervals.some(b => slotInterval.overlaps(b));
}

function buildNextAvailableSlots(nowLocal, busyIntervals, count = 2) {
  const lead = Number(MIN_LEAD_MINUTES);
  const duration = Number(DEMO_DURATION_MINUTES);
  const step = Number(SLOT_GRANULARITY_MINUTES);
  const days = Number(SEARCH_DAYS);
  const startHour = Number(WORK_START_HOUR);
  const endHour = Number(WORK_END_HOUR);

  const earliest = roundUpToGranularity(nowLocal.plus({ minutes: lead }));
  const results = [];

  for (let d = 0; d < days; d++) {
    const day = earliest.startOf("day").plus({ days: d });
    if (!isWeekday(day)) continue;

    let cursor = day.set({ hour: startHour, minute: 0, second: 0, millisecond: 0 });
    const end = day.set({ hour: endHour, minute: 0, second: 0, millisecond: 0 });

    while (cursor.plus({ minutes: duration }) <= end) {
      const slot = { start: cursor, end: cursor.plus({ minutes: duration }) };

      if (slot.start >= earliest && slotIsFree(slot, busyIntervals)) {
        results.push(slot);
        if (results.length >= count) return results;
      }

      cursor = cursor.plus({ minutes: step });
    }
  }

  return results;
}

/**
 * Given a preferred start time, if it's unavailable, return 1–2 nearby options.
 * "Nearby" means searching forward in 30-minute increments within the same day first,
 * then expanding slightly if needed.
 */
function buildNearbySlots(preferredStartLocal, busyIntervals, count = 2) {
  const duration = Number(DEMO_DURATION_MINUTES);
  const step = Number(SLOT_GRANULARITY_MINUTES);

  const preferred = {
    start: preferredStartLocal,
    end: preferredStartLocal.plus({ minutes: duration })
  };

  // If preferred is valid and free, return it as a single option
  if (isWeekday(preferred.start) && withinWorkHours(preferred.start, preferred.end) && slotIsFree(preferred, busyIntervals)) {
    return [preferred];
  }

  // Otherwise search nearby in same day: +30, +60, +90, ... then -30, -60, ...
  const options = [];
  const maxSteps = 12; // up to 6 hours range

  for (let i = 1; i <= maxSteps && options.length < count; i++) {
    const forwardStart = preferredStartLocal.plus({ minutes: i * step });
    const forward = { start: forwardStart, end: forwardStart.plus({ minutes: duration }) };

    if (isWeekday(forward.start) && withinWorkHours(forward.start, forward.end) && slotIsFree(forward, busyIntervals)) {
      options.push(forward);
      if (options.length >= count) break;
    }
  }

  for (let i = 1; i <= maxSteps && options.length < count; i++) {
    const backStart = preferredStartLocal.minus({ minutes: i * step });
    const back = { start: backStart, end: backStart.plus({ minutes: duration }) };

    if (isWeekday(back.start) && withinWorkHours(back.start, back.end) && slotIsFree(back, busyIntervals)) {
      options.push(back);
      if (options.length >= count) break;
    }
  }

  // Sort chronologically
  options.sort((a, b) => a.start.toMillis() - b.start.toMillis());
  return options;
}

function formatSlotForCaller(slot) {
  // Example: "Tue, Feb 10 at 9:00 AM ET"
  return slot.start.toFormat("ccc, LLL d 'at' h:mm a") + " ET";
}

function toSlotResponse(slot) {
  return {
    start_time: slot.start.toISO(),
    end_time: slot.end.toISO(),
    label: formatSlotForCaller(slot)
  };
}

// =====================
// HEALTH
// =====================
app.get("/", (_, res) => res.json({ ok: true }));
app.get("/health", (_, res) => res.json({ ok: true }));

// =====================
// RETELL → GET SLOTS (no preference)
// Returns 2 next available slots
// =====================
app.post("/retell/get_slots", async (req, res) => {
  try {
    const { calendar } = getGoogleClients();
    const nowLocal = DateTime.now().setZone(DEFAULT_TIMEZONE);

    // Query a reasonable window for freebusy
    const timeMin = nowLocal.toUTC().toISO();
    const timeMax = nowLocal.plus({ days: Number(SEARCH_DAYS) }).toUTC().toISO();

    const busy = await getBusyIntervals(calendar, timeMin, timeMax);
    const slots = buildNextAvailableSlots(nowLocal, busy, 2);

    return res.json({
      status: slots.length ? "ok" : "no_slots",
      options: slots.map(toSlotResponse)
    });
  } catch (err) {
    console.error("GET_SLOTS ERROR:", err);
    return res.status(500).json({ status: "error", message: err.message });
  }
});

// =====================
// RETELL → GET SLOTS NEAR a preferred time
// Body: { preferred_start_time: "2026-02-10T13:00:00-05:00" }
// Returns:
// - if preferred is free: options=[preferred]
// - if not: options=[1-2 nearby free slots]
// =====================
app.post("/retell/get_slots_near", async (req, res) => {
  try {
    const payload = req.body?.args ?? req.body?.arguments ?? req.body ?? {};
    const { preferred_start_time } = payload;

    if (!preferred_start_time) {
      return res.status(400).json({ status: "error", message: "Missing preferred_start_time" });
    }

    const preferredLocal = DateTime.fromISO(preferred_start_time, { zone: DEFAULT_TIMEZONE });
    if (!preferredLocal.isValid) {
      return res.status(400).json({ status: "error", message: "Invalid preferred_start_time format" });
    }

    const nowLocal = DateTime.now().setZone(DEFAULT_TIMEZONE);
    const lead = Number(MIN_LEAD_MINUTES);
    if (preferredLocal < nowLocal.plus({ minutes: lead })) {
      return res.json({
        status: "unavailable",
        reason: "too_soon",
        options: []
      });
    }

    const { calendar } = getGoogleClients();

    // Freebusy for the preferred day (work hours) to compute nearby
    const dayStart = preferredLocal.startOf("day").set({ hour: Number(WORK_START_HOUR), minute: 0 });
    const dayEnd = preferredLocal.startOf("day").set({ hour: Number(WORK_END_HOUR), minute: 0 });

    const busy = await getBusyIntervals(calendar, dayStart.toUTC().toISO(), dayEnd.toUTC().toISO());
    const nearby = buildNearbySlots(preferredLocal, busy, 2);

    if (nearby.length === 1 && nearby[0].start.toISO() === preferredLocal.toISO()) {
      return res.json({
        status: "ok",
        options: nearby.map(toSlotResponse)
      });
    }

    return res.json({
      status: nearby.length ? "unavailable" : "no_slots",
      options: nearby.map(toSlotResponse)
    });
  } catch (err) {
    console.error("GET_SLOTS_NEAR ERROR:", err);
    return res.status(500).json({ status: "error", message: err.message });
  }
});

// =====================
// RETELL → BOOK DEMO (books EXACT requested time)
// Body:
// {
//   full_name, email, phone, business_type, notes,
//   preferred_start_time
// }
// Behavior:
// - if preferred_start_time missing -> return 2 options
// - if time not available -> return 1-2 nearby options
// - if available -> book it
// =====================
app.post("/retell/book_demo", async (req, res) => {
  try {
    const payload = req.body?.args ?? req.body?.arguments ?? req.body ?? {};

    const {
      full_name,
      email,
      phone,
      business_type = "",
      notes = "",
      preferred_start_time
    } = payload;

    const missing = [];
    if (!full_name) missing.push("full_name");
    if (!email) missing.push("email");
    if (!phone) missing.push("phone");
    if (missing.length) {
      return res.status(400).json({ status: "error", message: "Missing required fields", missing });
    }

    const { calendar, sheets } = getGoogleClients();
    const nowLocal = DateTime.now().setZone(DEFAULT_TIMEZONE);

    // If no preferred time, give 2 options (caller must choose)
    if (!preferred_start_time) {
      const timeMin = nowLocal.toUTC().toISO();
      const timeMax = nowLocal.plus({ days: Number(SEARCH_DAYS) }).toUTC().toISO();
      const busy = await getBusyIntervals(calendar, timeMin, timeMax);

      const slots = buildNextAvailableSlots(nowLocal, busy, 2);
      return res.json({
        status: slots.length ? "need_choice" : "no_slots",
        options: slots.map(toSlotResponse)
      });
    }

    const preferredStartLocal = DateTime.fromISO(preferred_start_time, { zone: DEFAULT_TIMEZONE });
    if (!preferredStartLocal.isValid) {
      return res.status(400).json({ status: "error", message: "Invalid preferred_start_time format" });
    }

    const lead = Number(MIN_LEAD_MINUTES);
    if (preferredStartLocal < nowLocal.plus({ minutes: lead })) {
      return res.json({
        status: "unavailable",
        reason: "too_soon",
        options: []
      });
    }

    const duration = Number(DEMO_DURATION_MINUTES);
    const preferredSlot = {
      start: preferredStartLocal,
      end: preferredStartLocal.plus({ minutes: duration })
    };

    // Basic rule checks (weekday + business hours)
    if (!isWeekday(preferredSlot.start) || !withinWorkHours(preferredSlot.start, preferredSlot.end)) {
      return res.json({
        status: "unavailable",
        reason: "outside_business_hours",
        options: []
      });
    }

    // Check availability on that day
    const dayStart = preferredStartLocal.startOf("day").set({ hour: Number(WORK_START_HOUR), minute: 0 });
    const dayEnd = preferredStartLocal.startOf("day").set({ hour: Number(WORK_END_HOUR), minute: 0 });

    const busy = await getBusyIntervals(calendar, dayStart.toUTC().toISO(), dayEnd.toUTC().toISO());

    // If not free, offer 1–2 nearby slots
    if (!slotIsFree(preferredSlot, busy)) {
      const nearby = buildNearbySlots(preferredStartLocal, busy, 2).filter(s => s.start.toISO() !== preferredStartLocal.toISO());
      return res.json({
        status: nearby.length ? "unavailable" : "no_slots",
        options: nearby.map(toSlotResponse)
      });
    }

    // Book the exact preferred slot
    const event = await calendar.events.insert({
      calendarId: GCAL_ID,
      requestBody: {
        summary: `MK Receptions Demo – ${full_name}`,
        description:
          `Name: ${full_name}\n` +
          `Email: ${email}\n` +
          `Phone: ${phone}\n` +
          `Business: ${business_type}\n` +
          `Notes: ${notes}`,
        start: { dateTime: preferredSlot.start.toISO(), timeZone: DEFAULT_TIMEZONE },
        end: { dateTime: preferredSlot.end.toISO(), timeZone: DEFAULT_TIMEZONE }
      }
    });

    const calendarLink = event.data.htmlLink || "";

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
          preferredSlot.start.toISO(),
          preferredSlot.end.toISO(),
          calendarLink,
          notes
        ]]
      }
    });

    return res.json({
      status: "confirmed",
      start_time: preferredSlot.start.toISO(),
      end_time: preferredSlot.end.toISO(),
      calendar_link: calendarLink
    });

  } catch (err) {
    console.error("BOOK_DEMO ERROR:", err);
    return res.status(500).json({ status: "error", message: err.message || "Internal server error" });
  }
});

// =====================
// TWILIO → RETELL STREAM
// =====================
function twiml(agentId) {
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
  res.send(twiml(RETELL_AGENT_ID));
});

app.get("/twilio/voice", (req, res) => {
  res.type("text/xml");
  res.send(twiml(RETELL_AGENT_ID));
});

// =====================
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
