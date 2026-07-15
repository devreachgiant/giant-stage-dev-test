// Netlify Function: stripe-webhook
// Receives Stripe webhook events and updates the Supabase invoices table.
// Configure this URL in Stripe Dashboard → Webhooks:
//   https://giant-reachgiant.netlify.app/.netlify/functions/stripe-webhook
// Events to listen for:
//   invoice.paid, invoice.payment_failed, invoice.finalized, invoice.voided,
//   invoice.marked_uncollectible
//
// Env vars needed:
//   STRIPE_WEBHOOK_SECRET (whsec_...) - from Stripe Webhook settings
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY (NOT the anon key — service role for bypassing RLS)

const crypto = require('crypto');

function verifySignature(payload, sigHeader, secret) {
  if (!sigHeader || !secret) return false;
  // Format: t=timestamp,v1=signature
  const parts = sigHeader.split(',').reduce((acc, p) => {
    const [k, v] = p.split('=');
    acc[k] = v;
    return acc;
  }, {});
  const t = parts.t;
  const sig = parts.v1;
  if (!t || !sig) return false;
  const signedPayload = `${t}.${payload}`;
  const expected = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}

async function supabaseUpdate(table, match, patch) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase env not configured');
  const params = Object.entries(match).map(([k, v]) => `${k}=eq.${encodeURIComponent(v)}`).join('&');
  const res = await fetch(`${url}/rest/v1/${table}?${params}`, {
    method: 'PATCH',
    headers: {
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify(patch)
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Supabase ${res.status}: ${txt}`);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  // Stripe integration is disabled when the webhook secret is absent — fail closed and
  // process nothing (keys removed by owner decision). This also closes the prior hole where
  // signature verification was skipped whenever the secret was unset, letting forged
  // "invoice paid" events through: verification below is now mandatory, never conditional.
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    return { statusCode: 503, body: 'Stripe integration disabled' };
  }

  const sigHeader = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];
  const payload = event.body;

  if (!verifySignature(payload, sigHeader, secret)) {
    return { statusCode: 400, body: 'Invalid signature' };
  }

  let evt;
  try { evt = JSON.parse(payload); } catch(e) { return { statusCode: 400, body: 'Invalid JSON' }; }

  console.log('[stripe-webhook]', evt.type, evt.data?.object?.id);

  try {
    const obj = evt.data.object;
    const stripeInvoiceId = obj.id;
    let patch = null;

    switch (evt.type) {
      case 'invoice.paid':
        patch = {
          status: 'paid',
          paid_at: new Date(obj.status_transitions?.paid_at * 1000 || Date.now()).toISOString(),
          stripe_pi_id: obj.payment_intent
        };
        break;
      case 'invoice.payment_failed':
        patch = { status: 'overdue' };
        break;
      case 'invoice.finalized':
        patch = {
          status: 'open',
          payment_link: obj.hosted_invoice_url
        };
        break;
      case 'invoice.voided':
        patch = { status: 'void' };
        break;
      case 'invoice.marked_uncollectible':
        patch = { status: 'uncollectible' };
        break;
      default:
        return { statusCode: 200, body: 'Event ignored' };
    }

    await supabaseUpdate('invoices', { stripe_invoice_id: stripeInvoiceId }, patch);
    return { statusCode: 200, body: 'OK' };
  } catch (e) {
    console.error('[stripe-webhook] error:', e);
    return { statusCode: 500, body: 'Server error: ' + e.message };
  }
};
