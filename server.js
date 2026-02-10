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

  GCAL_ID, // DO NOT default to "primary" when using service accounts
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

if (!GOOGLE_CLIENT_EMAIL) throw new Error("Missing GOOGLE_CLIENT_EMAIL");
if (!GOOGLE_PRIVATE_KEY) throw new Error("Missing GOOGLE_PRIVATE_KEY");
if (!GCAL_ID) throw new Error("Missing GCAL_ID (use your calendar ID, not 'primary')");
if (!SHEET_ID) throw new Error("Missing SHEET_ID");
if (!RETELL_AGENT_ID) throw new Error("Missing RETELL_AGENT_ID");

// =====================
// GOOGLE CLIENTS
// =====================
function getGoogleClients() {
  // ✅ Render often stores \n literally; convert to real newlines
  const fixedPrivateKey = GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n");

  const auth = new google.auth.JWT(
    GOOGLE_CLIENT_EMAIL,
    undefined,
    fixedPrivateKey,
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
        slots.push({ start: cursor, end: cursor.plus({ minutes: duration }) });
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
// HEALTH CHECKS
// =====================
app.get("/", (req, res) => res.json({ ok: true }));
app.get("/health", (req, res) => res.json({ ok: true }));

// =====================
// RETELL → BOOK DEMO
// =====================
app.post("/retell/book_demo", async (req, res) => {
  try {
    // Supports both payload shapes:
    // - args-only: { full_name, email, phone, ... }
    // - wrapped:   { args: { full_name, email, phone, ... } }
    const payload = req.body?.args ?? req.body?.arguments ?? req.body ?? {};

    console.log("BOOK_DEMO raw body:", JSON.stringify(req.body));
    console.log("BOOK_DEMO payload:", JSON.stringify(payload));

    const { full_name, email, phone, business_type = "", notes = "" } = payload;

    const missing = [];
    if (!full_name) missing.push("full_name");
    if (!email) missing.push("email");
    if (!phone) missing.push("phone");

    if (missing.length) {
      return res.status(400).json({
        status: "error",
        message: "Missing required fields",
        missing
      });
    }

    const { calendar, sheets } = getGoogleClients();
    const nowLocal = DateTime.now().setZone(DEFAULT_TIMEZONE);

    const candidates = buildCandidateSlots(nowLocal);
    if (!candidates.length) return res.json({ status: "no_slots" });

    // Free/busy check
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

    // Create calendar event + Meet link
    const event = await calendar.events.insert({
      calendarId: GCAL_ID,
      conferenceDataVersion: 1,
      requestBody: {
        summary: `MK Receptions Demo – ${full_name}`,
        description:
          `Email: ${email}\n` +
          `Phone: ${phone}\n` +
          `Business: ${business_type}\n` +
          `${notes}`,
        start: { dateTime: slot.start.toISO(), timeZone: DEFAULT_TIMEZONE },
        end: { dateTime: slot.end.toISO(), timeZone: DEFAULT_TIMEZONE },
        attendees: [{ email }],
        conferenceData: {
          createRequest: {
            requestId: `meet-${Date.now()}`,
            conferenceSolutionKey: { type: "hangoutsMeet" }
          }
        }
      }
    });

    const meetLink =
      event.data.conferenceData?.entryPoints?.find(e => e.entryPointType === "video")?.uri ||
      event.data.hangoutLink ||
      "";

    // Append to sheet
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
          meetLink
        ]]
      }
    });

    return res.json({
      status: "confirmed",
      start_time: slot.start.toISO(),
      end_time: slot.end.toISO(),
      meeting_link: meetLink
    });

  } catch (err) {
    console.error("BOOK DEMO ERROR:", err);
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

// Optional GET for browser testing
app.get("/twilio/voice", (req, res) => {
  res.type("text/xml");
  res.send(twimlStreamResponse(RETELL_AGENT_ID));
});

// =====================
// START SERVER
// =====================
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
