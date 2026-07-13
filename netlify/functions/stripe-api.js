// Netlify Function: stripe-api proxy
// Calls Stripe REST API server-side with the platform secret key + Stripe-Account header
// to act on behalf of the connected account.

const STRIPE_API_BASE = 'https://api.stripe.com/v1';

function toFormUrlEncoded(obj, prefix = '') {
  const parts = [];
  function encode(key, val) {
    if (val === undefined || val === null) return;
    if (typeof val === 'object' && !Array.isArray(val)) {
      Object.keys(val).forEach(k => encode(`${key}[${k}]`, val[k]));
    } else if (Array.isArray(val)) {
      val.forEach((v, i) => encode(`${key}[${i}]`, v));
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(val)}`);
    }
  }
  Object.keys(obj).forEach(k => encode(prefix ? `${prefix}[${k}]` : k, obj[k]));
  return parts.join('&');
}

async function stripeCall(path, method, params, secretKey, stripeAccount) {
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${secretKey}`,
      'Stripe-Version': '2024-11-20.acacia'
    }
  };
  if (stripeAccount) opts.headers['Stripe-Account'] = stripeAccount;
  let url = `${STRIPE_API_BASE}${path}`;
  if (method === 'GET' && params && Object.keys(params).length) {
    url += '?' + toFormUrlEncoded(params);
  } else if (method !== 'GET' && params) {
    opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    opts.body = toFormUrlEncoded(params);
  }
  const res = await fetch(url, opts);
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.error?.message || `Stripe ${res.status}`);
    err.statusCode = res.status;
    err.code = data.error?.code;
    throw err;
  }
  return data;
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  const SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  if (!SECRET_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'STRIPE_SECRET_KEY not configured' }) };

  let body;
  try { body = JSON.parse(event.body); } catch(e) { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }
  const { action, params, stripe_user_id } = body;

  try {
    let result;
    switch (action) {
      case 'create_customer':       result = await stripeCall('/customers', 'POST', params, SECRET_KEY, stripe_user_id); break;
      case 'retrieve_customer':     result = await stripeCall(`/customers/${params.id}`, 'GET', null, SECRET_KEY, stripe_user_id); break;
      case 'create_invoice':        result = await stripeCall('/invoices', 'POST', params, SECRET_KEY, stripe_user_id); break;
      case 'add_invoice_item':      result = await stripeCall('/invoiceitems', 'POST', params, SECRET_KEY, stripe_user_id); break;
      case 'finalize_invoice':      result = await stripeCall(`/invoices/${params.id}/finalize`, 'POST', {}, SECRET_KEY, stripe_user_id); break;
      case 'send_invoice':          result = await stripeCall(`/invoices/${params.id}/send`, 'POST', {}, SECRET_KEY, stripe_user_id); break;
      case 'void_invoice':          result = await stripeCall(`/invoices/${params.id}/void`, 'POST', {}, SECRET_KEY, stripe_user_id); break;
      case 'retrieve_invoice':      result = await stripeCall(`/invoices/${params.id}`, 'GET', null, SECRET_KEY, stripe_user_id); break;
      case 'list_invoices':         result = await stripeCall('/invoices', 'GET', params || { limit: 50 }, SECRET_KEY, stripe_user_id); break;
      case 'list_customers':        result = await stripeCall('/customers', 'GET', params || { limit: 50 }, SECRET_KEY, stripe_user_id); break;
      case 'list_charges':          result = await stripeCall('/charges', 'GET', params || { limit: 50 }, SECRET_KEY, stripe_user_id); break;
      case 'list_balance_txns':     result = await stripeCall('/balance_transactions', 'GET', params || { limit: 50 }, SECRET_KEY, stripe_user_id); break;
      case 'retrieve_balance':      result = await stripeCall('/balance', 'GET', null, SECRET_KEY, stripe_user_id); break;
      case 'retrieve_account':      result = await stripeCall('/account', 'GET', null, SECRET_KEY, stripe_user_id); break;
      case 'deauthorize':
        result = await stripeCall('/oauth/deauthorize', 'POST', {
          client_id: process.env.STRIPE_CLIENT_ID,
          stripe_user_id: stripe_user_id
        }, SECRET_KEY, null);
        break;
      default:
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action: ' + action }) };
    }
    return { statusCode: 200, headers, body: JSON.stringify({ data: result }) };
  } catch (e) {
    console.error('[stripe-api]', action, e.message);
    return { statusCode: e.statusCode || 500, headers, body: JSON.stringify({ error: e.message, code: e.code }) };
  }
};
