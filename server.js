const express = require("express");
const axios = require("axios");
const { claimNotification } = require("./u7buy-dedupe");
const {
  startGameflipPoller,
  getGameflipStatus,
  sendTestNotification,
} = require("./gameflip");

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK || "";
function sanitizeMentionUserId(raw) {
  if (raw == null || raw === "") {
    return "";
  }

  let id = String(raw).trim().replace(/^["']|["']$/g, "");
  const mentionMatch = id.match(/^<@!?(\d+)>$/);
  if (mentionMatch) {
    id = mentionMatch[1];
  }

  return /^\d{17,20}$/.test(id) ? id : "";
}

function getU7buyMentionUserId() {
  const fromU7buy = sanitizeMentionUserId(
    process.env.DISCORD_MENTION_USER_ID_U7BUY
  );
  if (fromU7buy) {
    return fromU7buy;
  }

  return sanitizeMentionUserId(process.env.DISCORD_MENTION_USER_ID);
}
const U7BUY_ORDER_URL =
  process.env.U7BUY_ORDER_URL ||
  "https://www.u7buy.com/member/sold-order/details?orderId=";

app.use(express.json());

const okResponse = (res) => res.status(200).json({ status: "OK" });

function logWebhook(method, payload) {
  console.log(
    `[webhook] ${new Date().toISOString()} ${method}`,
    JSON.stringify(payload ?? {})
  );
}

async function notifyDiscord(data) {
  if (!DISCORD_WEBHOOK) {
    console.warn("[webhook] DISCORD_WEBHOOK not set — skipping Discord");
    return;
  }

  let message = "";

  if (data?.event === "new_order_received") {
    const orderId = data.data?.orderId;
    if (orderId == null) {
      console.warn("[webhook] new_order_received missing orderId:", data);
      return;
    }
    if (!claimNotification(data.event, orderId)) {
      return;
    }
    message = `🛒 NEW ORDER\nOrder link: ${U7BUY_ORDER_URL}${orderId}`;
  } else {
    console.log(
      `[webhook] No Discord alert for event "${data?.event ?? "unknown"}"`
    );
    return;
  }

  if (!message) {
    return;
  }

  const payload = { content: message };
  const mentionUserId = getU7buyMentionUserId();

  if (data?.event === "new_order_received" && mentionUserId) {
    payload.content += `\n<@${mentionUserId}>`;
    payload.allowed_mentions = { parse: [], users: [mentionUserId] };
  }

  await axios.post(DISCORD_WEBHOOK, payload);
}

const webhookHandler = {
  get: (req, res) => {
    logWebhook("GET", req.query);
    return okResponse(res);
  },
  post: (req, res) => {
    logWebhook("POST", req.body);

    // Reply immediately so U7BUY gets OK within its 5s timeout (Render cold starts).
    okResponse(res);

    notifyDiscord(req.body).catch((err) => {
      console.error("[webhook] Discord notification failed:", err.message);
    });
  },
};

app.get("/webhook", webhookHandler.get);
app.get("/webhook/", webhookHandler.get);
app.post("/webhook", webhookHandler.post);
app.post("/webhook/", webhookHandler.post);

app.get("/", (req, res) => {
  res.send("Webhook running");
});

app.get("/gameflip/status", (req, res) => {
  res.status(200).json(getGameflipStatus());
});

app.post("/gameflip/test", async (req, res) => {
  try {
    const result = await sendTestNotification();
    return res.status(200).json({
      status: "OK",
      message: "Gameflip test notification sent to Discord",
      ...result,
    });
  } catch (err) {
    console.error("[gameflip] Test failed:", err.message);
    return res.status(500).json({ status: "ERROR", message: err.message });
  }
});

app.post("/webhook/test", async (req, res) => {
  const event = req.body?.event || "new_order_received";
  const orderId = req.body?.orderId || Date.now();

  const payload = {
    event,
    data: { orderId },
  };

  logWebhook("POST", payload);

  try {
    if (!DISCORD_WEBHOOK) {
      return res.status(200).json({
        status: "OK",
        discord: false,
        message: "Webhook OK but DISCORD_WEBHOOK is not set on Render",
        payload,
      });
    }

    await notifyDiscord(payload);
    return res.status(200).json({
      status: "OK",
      discord: true,
      message: `U7BUY test notification sent (${event})`,
      payload,
    });
  } catch (err) {
    console.error("[webhook] Test failed:", err.message);
    return res.status(500).json({ status: "ERROR", message: err.message });
  }
});

app.use((req, res) => {
  res.status(404).json({
    error: "Not Found",
    path: req.path,
    hint: "Use GET or POST /webhook",
  });
});

app.listen(PORT, HOST, () => {
  console.log(`Server listening on http://${HOST}:${PORT}`);
  startGameflipPoller();
});
