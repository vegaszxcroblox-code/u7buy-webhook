const express = require("express");
const axios = require("axios");

const app = express();

app.use(express.json());

const DISCORD_WEBHOOK =
  "YOUR_DISCORD_WEBHOOK";

app.post("/webhook", async (req, res) => {

  const data = req.body;

  let message = "";

  if (data.event === "new_order_received") {
    message =
      `🛒 NEW ORDER\nOrder ID: ${data.data.orderId}`;
  }

  if (data.event === "order_completed") {
    message =
      `✅ ORDER COMPLETED\nOrder ID: ${data.data.orderId}`;
  }

  if (message) {

    await axios.post(DISCORD_WEBHOOK, {
      content: message
    });

  }

  return res.status(200).json({
    status: "OK"
  });

});

app.get("/", (req, res) => {
  res.send("Webhook running");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT);
