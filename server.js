import express from "express";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const RETELL_WSS_URL = "wss://api.retellai.com/audio-stream";
const RETELL_API_KEY = process.env.RETELL_API_KEY; // set in Render env vars
const RETELL_AGENT_ID = process.env.RETELL_AGENT_ID; // optional but recommended

app.get("/", (req, res) => res.send("OK"));

app.post("/twilio/voice", (req, res) => {
  if (!RETELL_API_KEY) {
    res.type("text/xml");
    return res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Server misconfigured. Missing Retell API key.</Say>
</Response>`);
  }

  const agentParam = RETELL_AGENT_ID ? `<Parameter name="agent_id" value="${RETELL_AGENT_ID}" />` : "";

  res.type("text/xml");
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${RETELL_WSS_URL}">
      <Parameter name="api_key" value="${RETELL_API_KEY}" />
      ${agentParam}
    </Stream>
  </Connect>
</Response>`);
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Server running on port " + port));
