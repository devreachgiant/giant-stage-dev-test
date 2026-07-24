// Shared client + brand context builder for the Blog Content Agent (and future
// client-scoped writing agents). Turns a client record + brand kit + optional
// per-client content guidelines into a prompt block the writer must obey.
//
// This is the v1 stand-in for the platform's per-client memory (Track B): today it
// injects the structured brand fields; later the same call is backed by RAG retrieval
// over the client's document corpus. Keep the shape stable so the port is a swap.

function clean(s) {
  return (s === undefined || s === null) ? '' : String(s).trim();
}

// Returns a prompt-ready context block (empty string if nothing useful is known).
function brandVoiceContext({ kit, client, guidelines } = {}) {
  const lines = [];

  if (client) {
    if (clean(client.name)) lines.push(`Client / business: ${clean(client.name)}`);
    if (clean(client.industry)) lines.push(`Industry: ${clean(client.industry)}`);
    if (clean(client.company_website)) lines.push(`Website: ${clean(client.company_website)}`);
    // clients.services is a text column (not an array) — but accept either defensively.
    if (client.services) {
      const svc = Array.isArray(client.services) ? client.services.map(clean).filter(Boolean).join(', ') : clean(client.services);
      if (svc) lines.push(`Services offered: ${svc}`);
    }
  }

  if (kit) {
    if (clean(kit.name) && clean(kit.name) !== clean(client && client.name)) lines.push(`Brand name: ${clean(kit.name)}`);
    if (clean(kit.tone)) lines.push(`Brand tone — match it exactly in every sentence: ${clean(kit.tone)}`);
    if (clean(kit.voice_notes)) lines.push(`Voice notes: ${clean(kit.voice_notes)}`);
  }

  if (clean(guidelines)) {
    lines.push(`Client-specific content guidelines (HIGHEST priority — follow strictly, they override generic best practice):\n${clean(guidelines)}`);
  }

  if (!lines.length) return '';
  return `\n\nCLIENT & BRAND CONTEXT — every word choice, example, claim, and recommendation must reflect this specific client:\n${lines.map((l) => '- ' + l).join('\n')}`;
}

// Robustly pull the outermost JSON object/array out of an LLM response
// (strips code fences and any prose around it). Shared by the blog functions.
function extractJson(text) {
  let t = String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const firstObj = t.indexOf('{');
  const firstArr = t.indexOf('[');
  let start = -1, openCh = '{', closeCh = '}';
  if (firstArr !== -1 && (firstObj === -1 || firstArr < firstObj)) { start = firstArr; openCh = '['; closeCh = ']'; }
  else start = firstObj;
  if (start === -1) throw new Error('No JSON found. Raw start: ' + t.slice(0, 200));
  const end = t.lastIndexOf(closeCh);
  if (end <= start) throw new Error('Unterminated JSON. Raw start: ' + t.slice(0, 200));
  const slice = t.slice(start, end + 1);
  return JSON.parse(slice);
}

module.exports = { brandVoiceContext, extractJson };
