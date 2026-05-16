const express = require("express");
const axios = require("axios");
const { startGameflipPoller, getGameflipStatus } = require("./gameflip");

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK || "";

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
    message = `🛒 NEW ORDER\nOrder ID: ${data.data?.orderId}`;
  } else if (data?.event === "order_completed") {
    message = `✅ ORDER COMPLETED\nOrder ID: ${data.data?.orderId}`;
  }

  if (!message) {
    return;
  }

  await axios.post(DISCORD_WEBHOOK, { content: message });
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
