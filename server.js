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
  GCAL_ID = "primary",
  SHEET_ID,
  SHEET_TAB = "Bookings",
  DEFAULT_TIMEZONE = "America/Detroit",
  MIN_LEAD_MINUTES = "120",
  DEMO_DURATION_MINUTES = "30",
  SLOT_GRANULARITY_MINUTES = "30",
  SEARCH_DAYS = "14",
  WORK_START_HOUR = "9",
  WORK_END_HOUR = "17",
  RETELL_AGENT_ID
} = process.env;

if (!GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_JSON");
if (!SHEET_ID) throw new Error("Missing SHEET_ID");
if (!RETELL_AGENT_ID) throw new Error("Missing RETELL_AGENT_ID");

// =====================
// GOOGLE CLIENT
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
// TIME HELPERS
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

function slotIsFree(slot, busyIntervals) {
  const slotInterval = Interval.fromDateTimes(slot.start, slot.end);
  return !busyIntervals.some(b => slotInterval.overlaps(b));
}

// =====================
// HEALTH
// =====================
app.get("/", (_, res) => res.json({ ok: true }));
app.get("/health", (_, res) => res.json({ ok: true }));

// =====================
// RETELL → BOOK DEMO
// =====================
app.post("/retell/book_demo", async (req, res) => {
  try {
    const payload = req.body?.args ?? req.body?.arguments ?? req.body ?? {};

    const { full_name, email, phone, business_type = "", notes = "" } = payload;

    if (!full_name || !email || !phone) {
      return res.status(400).json({
        status: "error",
        message: "Missing required fields"
      });
    }

    const { calendar, sheets } = getGoogleClients();
    const nowLocal = DateTime.now().setZone(DEFAULT_TIMEZONE);

    const candidates = buildCandidateSlots(nowLocal);
    if (!candidates.length) return res.json({ status: "no_slots" });

    const fb = await calendar.freebusy.query({
      requestBody: {
        timeMin: candidates[0].start.toUTC().toISO(),
        timeMax: candidates[candidates.length - 1].end.toUTC().toISO(),
        items: [{ id: GCAL_ID }]
      }
    });

    const busy = (fb.data.calendars?.[GCAL_ID]?.busy || []).map(b =>
      Interval.fromDateTimes(DateTime.fromISO(b.start), DateTime.fromISO(b.end))
    );

    const slot = candidates.find(s => slotIsFree(s, busy));
    if (!slot) return res.json({ status: "no_slots" });

    // ✅ NO conferenceData (this fixes your error)
    const event = await calendar.events.insert({
      calendarId: GCAL_ID,
      requestBody: {
        summary: `MK Receptions Demo – ${full_name}`,
        description:
          `Email: ${email}\nPhone: ${phone}\nBusiness: ${business_type}\n${notes}`,
        start: { dateTime: slot.start.toISO(), timeZone: DEFAULT_TIMEZONE },
        end: { dateTime: slot.end.toISO(), timeZone: DEFAULT_TIMEZONE }
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
          slot.start.toISO(),
          slot.end.toISO(),
          event.data.htmlLink
        ]]
      }
    });

    return res.json({
      status: "confirmed",
      start_time: slot.start.toISO(),
      end_time: slot.end.toISO(),
      calendar_link: event.data.htmlLink
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

// =====================
// TWILIO → RETELL
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
