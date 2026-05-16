const express = require("express");
const axios = require("axios");
const {
  startGameflipPoller,
  getGameflipStatus,
  sendTestNotification,
} = require("./gameflip");

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK || "";
const DISCORD_MENTION_USER_ID = process.env.DISCORD_MENTION_USER_ID || "";
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
    return;
  }

  let message = "";

  if (data?.event === "new_order_received") {
    const orderId = data.data?.orderId;
    message = `🛒 NEW ORDER\n${U7BUY_ORDER_URL}${orderId}`;
  }

  if (!message) {
    return;
  }

  const payload = { content: message };
  const mentionOnNewOrder =
    data?.event === "new_order_received" && DISCORD_MENTION_USER_ID;

  if (mentionOnNewOrder) {
    payload.content += `\n<@${DISCORD_MENTION_USER_ID}>`;
    payload.allowed_mentions = { users: [DISCORD_MENTION_USER_ID] };
  }

  await axios.post(DISCORD_WEBHOOK, payload);
}

const webhookHandler = {
  get: (req, res) => {
    logWebhook("GET", req.query);
    return okResponse(res);
  },
  post: async (req, res) => {
    logWebhook("POST", req.body);

    try {
      await notifyDiscord(req.body);
    } catch (err) {
      console.error("[webhook] Discord notification failed:", err.message);
    }

    return okResponse(res);
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
    const exchange = await sendTestNotification();
    return res.status(200).json({
      status: "OK",
      message: "Gameflip test notification sent to Discord",
      exchange,
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
