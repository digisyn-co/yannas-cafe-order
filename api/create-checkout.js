// /api/create-checkout.js
// Creates a PayMongo Checkout Session server-side (secret key never exposed to client).
// Prices are computed from an authoritative server-side menu — the client-sent price is IGNORED,
// so a tampered cart cannot underpay.

// id -> price. Object means temperature-dependent {hot, cold}. Keep in sync with the menu.
const PRICES = {
  1: { hot: 105, cold: 120 },   // Black Coffee
  2: 160,                        // Salted Cream Coffee
  3: 175,                        // Coconut Coffee
  4: { hot: 170, cold: 185 },   // Egg Coffee
  5: { hot: 115, cold: 130 },   // Milk Coffee
  6: 160,                        // Matcha Latte
  7: 175,                        // Salt Matcha
  8: 185,                        // Egg Custard Matcha
  9: 110, 10: 110, 11: 110, 12: 110,   // Fruit Teas
  13: 140, 14: 130, 15: 155,           // Sandwiches
  19: 130, 20: 115, 21: 145,           // Fried Rice
  22: 55, 23: 55, 24: 65,              // Add-ons
};

const ALLOWED = (process.env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean);
function setCors(req, res) {
  const origin = req.headers.origin || '';
  const ok = origin && (origin.endsWith('.vercel.app') || ALLOWED.includes(origin));
  if (ok) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function priceFor(item) {
  const p = PRICES[item.id];
  if (p == null) return null;                       // unknown item id -> reject
  if (typeof p === 'object') {
    const t = String(item.temp || '').toLowerCase();
    return t === 'hot' ? p.hot : p.cold;            // default to cold if unspecified
  }
  return p;
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SECRET = process.env.PAYMONGO_SECRET_KEY;
  if (!SECRET) return res.status(500).json({ error: 'Payment gateway not configured' });

  const { items, order_number, customer_name, customer_phone, success_url, cancel_url, payment_method_types } = req.body;

  if (!items?.length || !success_url) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Build line items from SERVER prices; reject anything we can't price.
  const lineItems = [];
  let serverTotal = 0;
  for (const item of items) {
    const qty = Math.max(1, parseInt(item.qty, 10) || 0);
    const unit = priceFor(item);
    if (unit == null) {
      return res.status(400).json({ error: `Unrecognized item in cart (id ${item.id})` });
    }
    serverTotal += unit * qty;
    lineItems.push({
      currency: 'PHP',
      amount: unit * 100, // centavos, from the server price
      name: (item.name || ('Item ' + item.id)) + (item.temp ? ` (${item.temp})` : ''),
      quantity: qty,
    });
  }
  if (serverTotal <= 0) return res.status(400).json({ error: 'Empty or invalid order' });

  const encoded = Buffer.from(SECRET + ':').toString('base64');

  try {
    const pmRes = await fetch('https://api.paymongo.com/v1/checkout_sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${encoded}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        data: {
          attributes: {
            line_items: lineItems,
            payment_method_types: (Array.isArray(payment_method_types) && payment_method_types.length) ? payment_method_types : ['gcash', 'card', 'qrph'],
            success_url,
            cancel_url,
            description: `Yanna's Cafe - Drive-Thru ${order_number || ''}`.trim(),
            metadata: {
              order_number: order_number || '',
              customer_name: customer_name || '',
              customer_phone: customer_phone || '',
              server_total: String(serverTotal),
            },
            billing: {
              name: customer_name || '',
              phone: customer_phone || '',
            },
          },
        },
      }),
    });

    const data = await pmRes.json();

    if (!pmRes.ok) {
      const errMsg = data.errors?.[0]?.detail || 'PayMongo error';
      return res.status(400).json({ error: errMsg });
    }

    return res.status(200).json({
      checkout_url: data.data.attributes.checkout_url,
      session_id: data.data.id,
      server_total: serverTotal,
    });

  } catch (err) {
    console.error('PayMongo error:', err);
    return res.status(500).json({ error: 'Payment gateway unreachable' });
  }
}
