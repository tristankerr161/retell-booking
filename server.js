import express from "express";
import { google } from "googleapis";
import { DateTime, Interval } from "luxon";

const app = express();

/**
 * Twilio sends application/x-www-form-urlencoded
 * Retell sends JSON
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
  WORK_START_HOUR = "9",
  WORK_END_HOUR = "17",

  RETELL_AGENT_ID
} = process.env;

if (!SHEET_ID) throw new Error("Missing SHEET_ID");
if (!RETELL_AGENT_ID) throw new Error("Missing RETELL_AGENT_ID");

// =====================
// GOOGLE AUTH
// =====================
function normalizePrivateKey(key) {
  return key?.replace(/\\n/g, "\n").trim();
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
      client_email: parsed.client_email,
      private_key: normalizePrivateKey(parsed.private_key)
    };
  }

  throw new Error("Missing Google credentials");
}

function getGoogleClients() {
  const { client_email, private_key } = getGoogleCreds();

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
// SLOT HELPERS
// =====================
function isWeekday(dt) {
  return dt.weekday >= 1 && dt.weekday <= 5;
}

function buildCandidateSlots(now) {
  const lead = Number(MIN_LEAD_MINUTES);
  const duration = Number(DEMO_DURATION_MINUTES);
  const step = Number(SLOT_GRANULARITY_MINUTES);
  const days = Number(SEARCH_DAYS);

  const startHour = Number(WORK_START_HOUR);
  const endHour = Number(WORK_END_HOUR);

  const earliest = now.plus({ minutes: lead });
  const slots = [];

  for (let i = 0; i < days; i++) {
    const day = earliest.startOf("day").plus({ days: i });
    if (!isWeekday(day)) continue;

    let cursor = day.set({ hour: startHour, minute: 0 });
    const end = day.set({ hour: endHour, minute: 0 });

    while (cursor.plus({ minutes: duration }) <= end) {
      if (cursor >= earliest) {
        slots.push({
          start: cursor,
          end: cursor.plus({ minutes: duration })
        });
      }
      cursor = cursor.plus({ minutes: step });
    }
  }

  return slots;
}

function slotIsFree(slot, busy) {
  const interval = Interval.fromDateTimes(slot.start, slot.end);
  return !busy.some(b => interval.overlaps(b));
}

async function getBusy(calendar, startISO, endISO) {
  const res = await calendar.freebusy.query({
    requestBody: {
      timeMin: startISO,
      timeMax: endISO,
      items: [{ id: GCAL_ID }]
    }
  });

  return (res.data.calendars[GCAL_ID]?.busy || []).map(b =>
    Interval.fromDateTimes(DateTime.fromISO(b.start), DateTime.fromISO(b.end))
  );
}

function formatLabel(start, end) {
  return `${start.toFormat("ccc, LLL d")} at ${start.toFormat("h:mm a")}–${end.toFormat("h:mm a")} ET`;
}

function extractArgs(req) {
  return req.body?.args ?? req.body?.arguments ?? req.body ?? {};
}

// =====================
// HEALTH
// =====================
app.get("/", (_, res) => res.json({ ok: true }));
app.get("/health", (_, res) => res.json({ ok: true }));

// =====================
// GET SLOTS
// =====================
app.post("/retell/get_slots", async (req, res) => {
  const { calendar } = getGoogleClients();
  const now = DateTime.now().setZone(DEFAULT_TIMEZONE);

  const slots = buildCandidateSlots(now);
  const busy = await getBusy(calendar, slots[0].start.toUTC().toISO(), slots.at(-1).end.toUTC().toISO());

  const free = slots.filter(s => slotIsFree(s, busy)).slice(0, 2);

  res.json({
    slots: free.map(s => ({
      start_time: s.start.toISO(),
      end_time: s.end.toISO(),
      label: formatLabel(s.start, s.end)
    }))
  });
});

// =====================
// CHECK AVAILABILITY
// =====================
app.post("/retell/check_availability", async (req, res) => {
  const { start_time } = extractArgs(req);
  const start = DateTime.fromISO(start_time, { setZone: true }).setZone(DEFAULT_TIMEZONE);
  const end = start.plus({ minutes: DEMO_DURATION_MINUTES });

  const { calendar } = getGoogleClients();
  const busy = await getBusy(calendar, start.toUTC().toISO(), end.toUTC().toISO());

  res.json({
    available: slotIsFree({ start, end }, busy),
    start_time: start.toISO(),
    end_time: end.toISO(),
    label: formatLabel(start, end)
  });
});

// =====================
// NEARBY SLOTS
// =====================
app.post("/retell/get_nearby_slots", async (req, res) => {
  const { start_time } = extractArgs(req);
  const preferred = DateTime.fromISO(start_time, { setZone: true }).setZone(DEFAULT_TIMEZONE);

  const { calendar } = getGoogleClients();
  const slots = buildCandidateSlots(preferred.minus({ days: 1 }));
  const busy = await getBusy(calendar, slots[0].start.toUTC().toISO(), slots.at(-1).end.toUTC().toISO());

  const free = slots
    .filter(s => slotIsFree(s, busy))
    .sort((a, b) => Math.abs(a.start - preferred) - Math.abs(b.start - preferred))
    .slice(0, 2);

  res.json({
    slots: free.map(s => ({
      start_time: s.start.toISO(),
      end_time: s.end.toISO(),
      label: formatLabel(s.start, s.end)
    }))
  });
});

// =====================
// BOOK DEMO
// =====================
app.post("/retell/book_demo", async (req, res) => {
  const {
    full_name,
    email,
    phone,
    business_type,
    notes = "",
    start_time
  } = extractArgs(req);

  const start = DateTime.fromISO(start_time, { setZone: true }).setZone(DEFAULT_TIMEZONE);
  const end = start.plus({ minutes: DEMO_DURATION_MINUTES });

  const { calendar, sheets } = getGoogleClients();

  const event = await calendar.events.insert({
    calendarId: GCAL_ID,
    requestBody: {
      summary: `MK Receptions Demo – ${full_name}`,
      description:
        `Email: ${email}\nPhone: ${phone}\nBusiness: ${business_type}\n${notes}`,
      start: { dateTime: start.toISO(), timeZone: DEFAULT_TIMEZONE },
      end: { dateTime: end.toISO(), timeZone: DEFAULT_TIMEZONE }
    }
  });

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
        event.data.htmlLink
      ]]
    }
  });

  res.json({
    status: "confirmed",
    start_time: start.toISO(),
    end_time: end.toISO(),
    calendar_link: event.data.htmlLink
  });
});

// =====================
// TWILIO → RETELL
// =====================
app.post("/twilio/voice", (_, res) => {
  res.type("text/xml");
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://api.retellai.com/audio-stream">
      <Parameter name="agent_id" value="${RETELL_AGENT_ID}" />
    </Stream>
  </Connect>
</Response>`);
});

// =====================
// START SERVER (ONLY ONE)
// =====================
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
