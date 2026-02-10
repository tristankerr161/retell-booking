import express from "express";
import { google } from "googleapis";
import { DateTime, Interval } from "luxon";

const app = express();

/**
 * Twilio sends application/x-www-form-urlencoded
 * Retell custom functions send JSON
 */
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: "2mb" }));

// =====================
// ENV CONFIG
// =====================
const {
  GOOGLE_CLIENT_EMAIL,
  GOOGLE_PRIVATE_KEY,

  // Optional fallback
  GOOGLE_SERVICE_ACCOUNT_JSON,

  GCAL_ID = "primary",
  SHEET_ID,
  SHEET_TAB = "Bookings",

  // Use Eastern Time (ET)
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
  // Convert "\n" sequences into real newlines + trim
  return raw.replace(/\\n/g, "\n").replace(/\r\n/g, "\n").trim();
}

function getGoogleCreds() {
  // Preferred: split env vars
  if (GOOGLE_CLIENT_EMAIL && GOOGLE_PRIVATE_KEY) {
    return {
      client_email: GOOGLE_CLIENT_EMAIL.trim(),
      private_key: normalizePrivateKey(GOOGLE_PRIVATE_KEY)
    };
  }

  // Fallback: whole JSON in env
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
// TIME / SLOT HELPERS
// =====================
function isWeekday(dt) {
  return dt.weekday >= 1 && dt.weekday <= 5;
}

function buildCandidateSlots(nowLocal, options = {}) {
  const lead = Number(options.minLeadMinutes ?? MIN_LEAD_MINUTES);
  const duration = Number(options.durationMinutes ?? DEMO_DURATION_MINUTES);
  const step = Number(options.stepMinutes ?? SLOT_GRANULARITY_MINUTES);
  const days = Number(options.searchDays ?? SEARCH_DAYS);
  const startHour = Number(options.workStartHour ?? WORK_START_HOUR);
  const endHour = Number(options.workEndHour ?? WORK_END_HOUR);

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

function formatSlotForAgent(slot) {
  // Human-friendly ET time for the agent to read
  return {
    start_time: slot.start.toISO(), // ISO in ET offset
    end_time: slot.end.toISO(),
    label: slot.start.toFormat("ccc, LLL d 'at' h:mm a") + " ET"
  };
}

// =====================
// HEALTH
// =====================
app.get("/", (req, res) => res.json({ ok: true }));
app.get("/health", (req, res) => res.json({ ok: true }));

// =====================
// (1) GET NEXT SLOTS (no args)
// =====================
app.post("/retell/get_slots", async (req, res) => {
  try {
    const { calendar } = getGoogleClients();
    const nowLocal = DateTime.now().setZone(DEFAULT_TIMEZONE);

    const candidates = buildCandidateSlots(nowLocal);
    if (!candidates.length) return res.json({ status: "no_slots", slots: [] });

    const busy = await getBusyIntervals(
      calendar,
      candidates[0].start.toUTC().toISO(),
      candidates[candidates.length - 1].end.toUTC().toISO()
    );

    const open = candidates.filter((s) => slotIsFree(s, busy)).slice(0, 2);

    return res.json({
      status: open.length ? "ok" : "no_slots",
      timezone: "ET",
      slots: open.map(formatSlotForAgent)
    });
  } catch (err) {
    console.error("GET_SLOTS ERROR:", err);
    return res.status(500).json({ status: "error", message: err?.message || "Internal error" });
  }
});

// =====================
// (2) CONFIRM AVAILABILITY (start_time)
// =====================
app.post("/retell/confirm_availability", async (req, res) => {
  try {
    const payload = req.body?.args ?? req.body?.arguments ?? req.body ?? {};
    const { start_time } = payload;

    if (!start_time) {
      return res.status(400).json({ status: "error", message: "Missing start_time" });
    }

    const start = DateTime.fromISO(start_time, { setZone: true }).setZone(DEFAULT_TIMEZONE);
    if (!start.isValid) {
      return res.status(400).json({ status: "error", message: "Invalid start_time ISO" });
    }

    const duration = Number(DEMO_DURATION_MINUTES);
    const slot = { start, end: start.plus({ minutes: duration }) };

    const { calendar } = getGoogleClients();

    const busy = await getBusyIntervals(
      calendar,
      slot.start.toUTC().toISO(),
      slot.end.toUTC().toISO()
    );

    const available = slotIsFree(slot, busy);

    return res.json({
      status: "ok",
      available,
      timezone: "ET",
      slot: formatSlotForAgent(slot)
    });
  } catch (err) {
    console.error("CONFIRM_AVAILABILITY ERROR:", err);
    return res.status(500).json({ status: "error", message: err?.message || "Internal error" });
  }
});

// =====================
// (3) GET SLOTS NEAR (start_time, count=2)
// =====================
app.post("/retell/get_slots_near", async (req, res) => {
  try {
    const payload = req.body?.args ?? req.body?.arguments ?? req.body ?? {};
    const { start_time, count = 2 } = payload;

    if (!start_time) {
      return res.status(400).json({ status: "error", message: "Missing start_time" });
    }

    const preferred = DateTime.fromISO(start_time, { setZone: true }).setZone(DEFAULT_TIMEZONE);
    if (!preferred.isValid) {
      return res.status(400).json({ status: "error", message: "Invalid start_time ISO" });
    }

    const { calendar } = getGoogleClients();
    const nowLocal = DateTime.now().setZone(DEFAULT_TIMEZONE);

    // Generate candidates, but with lead time respected from now
    const candidates = buildCandidateSlots(nowLocal);
    if (!candidates.length) return res.json({ status: "no_slots", slots: [] });

    const busy = await getBusyIntervals(
      calendar,
      candidates[0].start.toUTC().toISO(),
      candidates[candidates.length - 1].end.toUTC().toISO()
    );

    // Prefer slots closest to preferred time
    const open = candidates
      .filter((s) => slotIsFree(s, busy))
      .map((s) => ({ ...s, diff: Math.abs(s.start.toMillis() - preferred.toMillis()) }))
      .sort((a, b) => a.diff - b.diff)
      .slice(0, Math.max(1, Number(count)));

    return res.json({
      status: open.length ? "ok" : "no_slots",
      timezone: "ET",
      slots: open.map(({ start, end }) => formatSlotForAgent({ start, end }))
    });
  } catch (err) {
    console.error("GET_SLOTS_NEAR ERROR:", err);
    return res.status(500).json({ status: "error", message: err?.message || "Internal error" });
  }
});

// =====================
// (4) BOOK DEMO (chosen start_time + confirmed info)
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
      start_time
    } = payload;

    const missing = [];
    if (!full_name) missing.push("full_name");
    if (!email) missing.push("email");
    if (!phone) missing.push("phone");
    if (!start_time) missing.push("start_time");

    if (missing.length) {
      return res.status(400).json({
        status: "error",
        message: "Missing required fields",
        missing
      });
    }

    const start = DateTime.fromISO(start_time, { setZone: true }).setZone(DEFAULT_TIMEZONE);
    if (!start.isValid) {
      return res.status(400).json({ status: "error", message: "Invalid start_time ISO" });
    }

    const duration = Number(DEMO_DURATION_MINUTES);
    const slot = { start, end: start.plus({ minutes: duration }) };

    const { calendar, sheets } = getGoogleClients();

    // Re-check availability right before booking (race-condition safe)
    const busy = await getBusyIntervals(
      calendar,
      slot.start.toUTC().toISO(),
      slot.end.toUTC().toISO()
    );

    if (!slotIsFree(slot, busy)) {
      return res.json({
        status: "unavailable",
        message: "That time was just taken.",
        timezone: "ET"
      });
    }

    // Create event on the calendar (no attendees / no Meet to avoid SA restrictions)
    const event = await calendar.events.insert({
      calendarId: GCAL_ID,
      requestBody: {
        summary: `MK Receptions Demo – ${full_name}`,
        description:
          `Name: ${full_name}\n` +
          `Email: ${email}\n` +
          `Phone: ${phone}\n` +
          `Business type: ${business_type}\n\n` +
          `Notes:\n${notes}`,
        start: { dateTime: slot.start.toISO(), timeZone: DEFAULT_TIMEZONE },
        end: { dateTime: slot.end.toISO(), timeZone: DEFAULT_TIMEZONE }
      }
    });

    const calendarLink = event.data.htmlLink || "";

    // Log to Sheets
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
          slot.start.toISO(),
          slot.end.toISO(),
          calendarLink
        ]]
      }
    });

    return res.json({
      status: "confirmed",
      timezone: "ET",
      start_time: slot.start.toISO(),
      end_time: slot.end.toISO(),
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
// START
// =====================
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
