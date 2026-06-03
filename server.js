require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// subscriber_id -> message history
const conversations = new Map();

const SYSTEM_PROMPT = `You are a sales assistant for Cape Caviar — a premium black caviar brand delivering across South Africa. You speak with customers via Instagram DM.

PRODUCTS & PRICES:
- Beluga (Huso huso) — large glossy pearls, creamy finish: 30g=R990, 50g=R1550, 100g=R2900, 125g=R3500
- Russian Sturgeon — mild, sweet hazelnut notes: 30g=R740, 50g=R1150, 100g=R2200, 125g=R2700
- Bester (Beluga × Sterlet hybrid) — buttery, complex, nutty: 30g=R690, 50g=R1080, 100g=R2000, 125g=R2500
- Sterlet — delicate small pearls, clean pure taste: 30g=R590, 50g=R920, 100g=R1700, 125g=R2100

DELIVERY:
- We deliver across all of South Africa
- Free delivery on orders over R450
- R300 delivery fee on orders under R450
- Temperature-controlled cold-chain delivery

TONE: Friendly but professional. Keep messages short — this is Instagram DM. No excessive emojis.

YOUR JOB: Help the customer choose products, answer questions, then collect the following to complete the order:
1. Products + sizes + quantities
2. Full delivery address
3. Phone number
4. Email address

Only after you have ALL FOUR pieces of info, add this block at the very end of your message — nothing after it:

<<<ORDER_COMPLETE>>>
{"items":[{"product":"Product Name","size":"30g","qty":1,"price":990}],"subtotal":990,"delivery":300,"total":1290,"email":"client@email.com","phone":"0821234567","address":"123 Main Road, Cape Town, 8001"}
<<<END_ORDER>>>

Rules:
- Never include the ORDER_COMPLETE block until you have all required info
- Never invent customer details — always ask if something is missing
- Calculate delivery: free if subtotal >= R450, otherwise add R300
- If the customer orders multiple items, list each in the items array`;

async function createPaystackLink(email, amountRand, description) {
  const reference = `CAVIAR-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  const response = await axios.post(
    'https://api.paystack.co/transaction/initialize',
    {
      email,
      amount: Math.round(amountRand * 100), // Paystack uses cents (kobo)
      reference,
      metadata: { order: description }
    },
    {
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }
    }
  );
  return response.data.data.authorization_url;
}

app.post('/webhook', async (req, res) => {
  try {
    const { subscriber_id, message } = req.body;

    if (!subscriber_id || !message) {
      return res.status(400).json({ error: 'Missing subscriber_id or message' });
    }

    if (!conversations.has(subscriber_id)) {
      conversations.set(subscriber_id, []);
    }

    const history = conversations.get(subscriber_id);
    history.push({ role: 'user', content: message });

    // Keep last 20 messages to manage token usage
    const trimmedHistory = history.slice(-20);

    const aiResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: trimmedHistory,
    });

    const fullReply = aiResponse.content[0].text;
    let visibleReply = fullReply;
    let paymentUrl = '';

    // Check if order is complete
    const orderMatch = fullReply.match(/<<<ORDER_COMPLETE>>>([\s\S]*?)<<<END_ORDER>>>/);
    if (orderMatch) {
      try {
        const orderData = JSON.parse(orderMatch[1].trim());
        const itemsSummary = orderData.items
          .map(i => `${i.product} ${i.size} x${i.qty}`)
          .join(', ');

        paymentUrl = await createPaystackLink(
          orderData.email,
          orderData.total,
          `Cape Caviar: ${itemsSummary}`
        );

        // Strip the JSON block from what the customer sees
        visibleReply = fullReply
          .replace(/<<<ORDER_COMPLETE>>>[\s\S]*?<<<END_ORDER>>>/, '')
          .trim();

        // Reset conversation after order is placed
        conversations.set(subscriber_id, []);

        console.log(`Order placed for ${subscriber_id}: ${itemsSummary} — R${orderData.total}`);
      } catch (e) {
        console.error('Order processing error:', e.message);
      }
    } else {
      // Save assistant reply to history
      history.push({ role: 'assistant', content: fullReply });
    }

    res.json({
      reply: visibleReply,
      payment_url: paymentUrl,
    });
  } catch (err) {
    console.error('Webhook error:', err.message);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Cape Caviar agent running on port ${PORT}`);
});
