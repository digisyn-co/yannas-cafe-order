// /api/drive-time.js
// Returns accurate driving time (minutes) from a customer's location to the cafe
// using the Google Distance Matrix API, with live traffic. The API key stays
// server-side and is never exposed to the browser.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const KEY = process.env.GOOGLE_MAPS_API_KEY;
  if (!KEY) return res.status(500).json({ error: 'Maps not configured' });

  const { origin_lat, origin_lng, dest_lat, dest_lng } = req.body;
  if (origin_lat == null || origin_lng == null || dest_lat == null || dest_lng == null) {
    return res.status(400).json({ error: 'Missing coordinates' });
  }

  const url = 'https://maps.googleapis.com/maps/api/distancematrix/json'
    + `?origins=${origin_lat},${origin_lng}`
    + `&destinations=${dest_lat},${dest_lng}`
    + '&mode=driving&departure_time=now&units=metric'
    + `&key=${KEY}`;

  try {
    const r = await fetch(url);
    const data = await r.json();
    const el = data?.rows?.[0]?.elements?.[0];

    if (data.status !== 'OK' || !el || el.status !== 'OK') {
      return res.status(400).json({ error: el?.status || data.status || 'No route found' });
    }

    // duration_in_traffic is present when departure_time=now and traffic data exists
    const dur = el.duration_in_traffic || el.duration;
    const seconds = dur.value;
    const meters = el.distance.value;

    return res.status(200).json({
      minutes: Math.max(1, Math.round(seconds / 60)),
      km: +(meters / 1000).toFixed(1),
      text: dur.text,
    });
  } catch (err) {
    console.error('drive-time error:', err);
    return res.status(500).json({ error: 'Maps unreachable' });
  }
}
