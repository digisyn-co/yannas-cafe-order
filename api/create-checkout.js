// /api/create-checkout.js
// Creates a PayMongo Checkout Session server-side (secret key never exposed to client)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SECRET = process.env.PAYMONGO_SECRET_KEY;
  if (!SECRET) return res.status(500).json({ error: 'Payment gateway not configured' });

  const { items, total, order_number, customer_name, customer_phone, success_url, cancel_url } = req.body;

  if (!items?.length || !total || !success_url) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const lineItems = items.map(item => ({
    currency: 'PHP',
    amount: item.price * 100, // PayMongo uses centavos
    name: item.name + (item.temp ? ` (${item.temp})` : ''),
    quantity: item.qty,
  }));

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
            payment_method_types: ['gcash', 'paymaya', 'card'],
            success_url,
            cancel_url,
            description: `Yanna's Cafe — Drive-Thru ${order_number}`,
            metadata: {
              order_number,
              customer_name,
              customer_phone,
            },
            billing: {
              name: customer_name,
              phone: customer_phone,
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
    });

  } catch (err) {
    console.error('PayMongo error:', err);
    return res.status(500).json({ error: 'Payment gateway unreachable' });
  }
}
