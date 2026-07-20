// Shared CORS origin allowlist for Netlify functions (security batch 2).
//
// Replaces the blanket 'Access-Control-Allow-Origin: *' every function shipped with.
// Browsers may only read responses from the origins below; requests from any other
// origin get the production origin back (a mismatch, so the browser blocks the read).
// Same-origin requests don't need the header at all, so the default is harmless.

const ALLOWED = [
  'https://giant.reachgiant.com',
  'https://giant-reachgiant.netlify.app',
];

function allowOrigin(event) {
  const h = (event && event.headers) || {};
  const origin = h.origin || h.Origin || '';
  if (ALLOWED.includes(origin)) return origin;
  // Netlify deploy previews / branch deploys for this site
  if (/^https:\/\/[a-z0-9-]+--giant-reachgiant\.netlify\.app$/.test(origin)) return origin;
  // Local development
  if (/^http:\/\/localhost(:\d+)?$/.test(origin)) return origin;
  return ALLOWED[0];
}

module.exports = { allowOrigin };
