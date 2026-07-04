// /api/verify-payment.js
// Verifies a PayMongo Checkout Session payment status server-side

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SECRET = process.env.PAYMONGO_SECRET_KEY;
  if (!SECRET) return res.status(500).json({ error: 'Payment gateway not configured' });

  const { session_id } = req.body;
  if (!session_id) return res.status(400).json({ error: 'Missing session_id' });

  const encoded = Buffer.from(SECRET + ':').toString('base64');

  try {
    const pmRes = await fetch(`https://api.paymongo.com/v1/checkout_sessions/${session_id}`, {
      headers: { 'Authorization': `Basic ${encoded}` },
    });

    const data = await pmRes.json();

    if (!pmRes.ok) {
      return res.status(400).json({ success: false, error: 'Could not retrieve session' });
    }

    const attrs = data.data?.attributes;
    const intentStatus = attrs?.payment_intent?.attributes?.status;
    const payments = attrs?.payments || [];
    const lastPayment = payments[payments.length - 1];
    const paymentMethod = lastPayment?.attributes?.source?.type || 'unknown';

    const paid = intentStatus === 'succeeded';

    return res.status(200).json({
      success: paid,
      status: intentStatus,
      payment_method: paymentMethod,
    });

  } catch (err) {
    console.error('Verify error:', err);
    return res.status(500).json({ success: false, error: 'Verification failed' });
  }
}
