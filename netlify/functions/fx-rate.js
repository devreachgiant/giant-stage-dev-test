// Netlify Function: fx-rate
// Fetches the current USD -> target currency exchange rate for Team Pay's local-currency
// display. Uses a free, no-API-key public endpoint. Called by the frontend when a currency
// is picked from the dropdown, to auto-fill (still user-editable) the exchange rate field.

const { allowOrigin } = require('./_cors');
const { requireUser } = require('./_auth');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': allowOrigin(event),
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  // Security batch 2: caller must be a logged-in Giant user. The frontend fetch
  // wrapper sends the Supabase session token; _auth.js verifies it with the Auth API.
  const auth = await requireUser(event);
  if (!auth.ok) return { statusCode: auth.response.statusCode, headers, body: auth.response.body };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers, body: JSON.stringify({ error: 'GET only' }) };

  const to = String((event.queryStringParameters || {}).to || '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(to)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Query param "to" must be a 3-letter currency code' }) };
  }
  if (to === 'USD') {
    return { statusCode: 200, headers, body: JSON.stringify({ code: 'USD', rate: 1, base: 'USD', date: null }) };
  }

  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD');
    if (!res.ok) throw new Error(`Rate provider ${res.status}`);
    const data = await res.json();
    const rate = data && data.rates && data.rates[to];
    if (!rate) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: `No rate found for ${to}` }) };
    }
    return { statusCode: 200, headers, body: JSON.stringify({ code: to, rate, base: 'USD', date: data.time_last_update_utc || null }) };
  } catch (e) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: 'Could not fetch exchange rate: ' + e.message }) };
  }
};
