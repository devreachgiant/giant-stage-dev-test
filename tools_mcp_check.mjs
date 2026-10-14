// Does the MCP server show a person only what they could already see?
//
// The one that matters: a MEMBER selecting from public.clients gets all 58 rows WITH
// mrr_cents and contact_name -- the app hides those by querying clients_public instead. So
// an MCP tool reading a base table would hand a specialist every client's MRR, not by
// breaking a rule but by walking around one. These checks fail if that ever happens.
//
// Run: node tools_mcp_check.mjs
import { readFileSync, readdirSync } from 'node:fs';

const results = [];
const check = (name, pass, detail) => { results.push({ name, pass: !!pass, detail }); };

const tools = readFileSync('netlify/functions/_mcp_tools.js', 'utf8');
const identity = readFileSync('netlify/functions/_mcp_identity.js', 'utf8');
const server = readFileSync('netlify/functions/mcp.js', 'utf8');
const oauth = readFileSync('netlify/functions/_mcp_oauth.js', 'utf8');

// 1. Nothing may read the clients base table except through clientSource().
const clientReads = [...tools.matchAll(/`?\$?\{?\s*(clients(?:_public|_manager)?)\s*\}?\?select/g)]
  .map(m => m[1]);
const directBaseRead = /['"`]clients\?select/.test(tools);
check('no tool reads the clients base table directly',
  !directBaseRead, 'found: ' + JSON.stringify(clientReads));

// 2. The role ladder matches the app's.
const ladder = (() => {
  const m = tools.match(/function clientSource\(role\)\s*\{[\s\S]*?\n\}/);
  if (!m) return null;
  const f = new Function('role', m[0].replace(/^function clientSource\(role\)\s*\{/, '').replace(/\}$/, ''));
  return { owner: f('owner'), inhouse: f('inhouse_dev'), manager: f('manager'),
           member: f('member'), unknown: f('') };
})();
check('owners read clients, managers clients_manager, everyone else clients_public',
  ladder && ladder.owner === 'clients' && ladder.inhouse === 'clients' &&
  ladder.manager === 'clients_manager' && ladder.member === 'clients_public' &&
  ladder.unknown === 'clients_public', JSON.stringify(ladder));

// 3. A non-manager must not even be ASKED for financial columns.
const colBlock = tools.match(/const cols = isManager\(ctx\.role\)[\s\S]*?;/);
const nonManagerCols = colBlock ? colBlock[0].split(':')[1] : '';
check('a non-manager is never asked for mrr_cents or contact details',
  !!colBlock && !/mrr_cents|contact_/.test(nonManagerCols), nonManagerCols.trim().slice(0, 90));

// 4. Reads must use the person's token, never the service key.
check('tools read as the person, not with the service role',
  !/SERVICE_KEY|SUPABASE_SERVICE_ROLE_KEY/.test(tools) && /asUser\(ctx\.accessToken/.test(tools),
  'service key referenced in tools: ' + /SERVICE_KEY/.test(tools));
check('asUser sends the user access token and the anon key, not the service key',
  /Authorization: `Bearer \$\{accessToken\}`/.test(identity) &&
  /apikey: ANON_KEY/.test(identity.match(/async function asUser[\s\S]*?\n\}/)?.[0] || ''),
  'ok');

// 5. A client-portal account cannot drive this.
check('a token whose owner is a client is refused',
  /role \|\| 'client'\)\.toLowerCase\(\) === 'client'\) return null/.test(identity), 'ok');

// 6. Tokens are stored hashed and looked up by hash.
check('tokens are matched by hash, never stored raw',
  /token_hash=eq\./.test(identity) && /createHash\('sha256'\)/.test(identity), 'ok');

// 7. Anything that needs data needs a credential -- and the refusal has to be a 401 carrying
//    WWW-Authenticate, because that header is not merely an error: it is the first step of
//    the OAuth flow, and without it claude.ai and ChatGPT have no way to offer a sign-in.
//    An earlier version of this check matched the exact shape of one `if` in the file, so it
//    failed the moment the file was restructured while the behaviour was unchanged. It now
//    asserts the behaviour: resolve a profile first, then 401 + WWW-Authenticate if there
//    isn't one.
const refusal = server.match(/if \(!profile\) \{[\s\S]{0,600}?\n  \}/);
check('an unauthenticated call is refused with 401 and an OAuth challenge',
  !!refusal && /statusCode:\s*401/.test(refusal[0]) &&
  /'WWW-Authenticate'/.test(refusal[0]) && /resource_metadata=/.test(refusal[0]),
  refusal ? 'ok' : 'no !profile branch found');

// 8. Both ways of being somebody end in a real session for that person, never in the tools
//    file deciding what to show.
check('a personal token and an OAuth token both resolve to a person',
  /profileForToken\(token\)/.test(server) && /verifyAccessToken\(token\)/.test(server) &&
  /sessionFor\(profile\)/.test(server), 'ok');

// 9. The spec is emphatic: a server MUST reject a token not issued for itself.
check('an access token is checked against this server\u2019s own audience',
  /row\.audience !== RESOURCE_URI/.test(oauth), 'ok');

// 10. PKCE, and only the form of it that is worth anything.
check('only S256 PKCE is accepted, never plain',
  /code_challenge_methods_supported:\s*\['S256'\]/.test(oauth) &&
  /createHash\('sha256'\)[\s\S]{0,80}base64url/.test(oauth), 'ok');

// 11. An authorization code must be single use. Burning it with a conditional update and
//     believing only our own burn is what makes two racing redemptions resolve to one.
check('an authorization code is burned before anything is issued, and only once',
  /used_at=is\.null/.test(oauth) && /burn\.body\.length\) return \{ error: 'invalid_grant' \}/.test(oauth),
  'ok');

// 12. Codes and tokens are secrets, so none of them may be stored in the clear.
check('codes, access tokens and refresh tokens are all stored hashed',
  /code_hash: sha256\(code\)/.test(oauth) && /token_hash: sha256\(access\)/.test(oauth) &&
  /refresh_hash: sha256\(refresh\)/.test(oauth), 'ok');

// 13. Redirect URIs are matched exactly. A prefix or hostname match is how tokens get
//     delivered to somebody else's server.
check('a redirect address is matched exactly, never by prefix',
  /registered\.some\(r => r === uri\)/.test(oauth) && !/startsWith\(/.test(
    (oauth.match(/function redirectAllowed[\s\S]*?\n\}/) || [''])[0]), 'ok');

// 14. Read-only: no tool may write.
check('every tool is read-only',
  !/method:\s*'(POST|PATCH|DELETE|PUT)'/.test(tools), 'ok');

// 9. The policy that stops a client-portal account minting a token must be RESTRICTIVE.
//    It shipped permissive, which meant it took nothing away: permissive policies for the
//    same command are ORed, and api_tokens_own (FOR ALL) already allowed the insert. In a
//    rolled-back probe on production a real client-role profile inserted a token. Restrictive
//    policies are ANDed, so they can actually deny.
//
//    Replaying the migrations in order and honouring the drops gives the state the database
//    is actually in, so a policy that was later dropped does not fail this.
const live = new Map();
for (const f of readdirSync('supabase/migrations').filter(f => f.endsWith('.sql')).sort()) {
  const sql = readFileSync('supabase/migrations/' + f, 'utf8');
  for (const m of sql.matchAll(/drop\s+policy\s+(?:if\s+exists\s+)?([\w"]+)\s+on\s+public\.api_tokens/gi)) {
    live.delete(m[1].replace(/"/g, ''));
  }
  for (const m of sql.matchAll(/create\s+policy\s+([\w"]+)\s+on\s+public\.api_tokens([\s\S]*?);/gi)) {
    live.set(m[1].replace(/"/g, ''), m[2]);
  }
}
const denies = [...live].filter(([, body]) => /<>\s*'client'/.test(body));
const permissive = denies.filter(([, body]) => !/as\s+restrictive/i.test(body)).map(([n]) => n);
check('the client block on api_tokens denies rather than merely permits',
  denies.length > 0 && permissive.length === 0,
  denies.length + ' live: ' + denies.map(([n]) => n).join(', ') +
  (permissive.length ? ' -- PERMISSIVE: ' + permissive.join(', ') : ''));

const fails = results.filter(r => !r.pass);
console.log('\n=== MCP SAFETY ===');
results.forEach(r => console.log((r.pass ? 'PASS  ' : 'FAIL  ') + r.name +
  (r.detail ? '   [' + r.detail + ']' : '')));
console.log(`\n${results.length - fails.length}/${results.length} checks passed`);
process.exit(fails.length ? 1 : 0);
