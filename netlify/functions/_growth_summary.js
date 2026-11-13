// Turning a call transcript into a summary. ONE copy of the prompt.
//
// There were about to be two: the Summarise this call button built its own prompt in
// index.html and called claude-api, and the recordings sync needed the same thing to
// write a summary the moment a transcript lands. Two prompts for one job drift, and the
// one that drifts is the one running at 3am unattended -- the same reason runRecordingSync
// is shared between the button and the timer. Both paths call this.
//
// WHO SAID WHAT, OR NOBODY DID. Zoom produces two different text files. TRANSCRIPT is the
// audio transcript and names the speaker on every line; CC is the live closed captions and
// names nobody. This account produces captions until "Create audio transcript" is switched
// on in Zoom, so most of what arrives is unattributed. Asked to summarise an unattributed
// wall of talk, a model hands back "the client said their budget is 1.5k" with no way of
// knowing it was us who said it -- a confident wrong answer in the one place it costs
// money. So the prompt is told which kind it has, and told to stop attributing when it
// cannot tell.

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';

/* The model the Summarise button has always used -- claude-api's default -- so moving
   that button onto this module does not quietly change what it writes. Upgrading is a
   line here and a decision worth making deliberately, not a side effect of this. */
const MODEL = 'claude-sonnet-4-5-20250929';

/* An hour of talk is well inside this. The cap is here so a runaway transcript cannot
   turn one call into a very expensive one. */
const MAX_CHARS = 60000;

/* Five lines of "Name: words" before this calls a transcript attributed. One or two can
   happen by accident in captions -- somebody says "Luke: are you there" -- and a single
   match would turn captions into a transcript the model is told it may attribute. */
function isAttributed(transcript) {
  return (String(transcript || '').match(/^[^\n:]{2,30}:\s/gm) || []).length >= 5;
}

function buildSystem(transcript) {
  return 'You summarise a sales call from its transcript, for the person who was ' +
    'on it. Use ONLY what is in the transcript. If something was not said, leave it ' +
    'out rather than filling it in. Four headings on their own lines: What they want ' +
    '/ What we said / Objections / Do next. Under Do next put only what somebody ' +
    'actually committed to, and nothing you think they should do. Plain text, no ' +
    'markdown, no dashes.' +
    (isAttributed(transcript)
      ? ' Each line names its speaker; you may say who said what.'
      : ' THIS TRANSCRIPT HAS NO SPEAKER NAMES. It is a stream of captions and you ' +
        'cannot tell who is talking. Never say who said something, and never guess ' +
        'which side is the client. Write what was DISCUSSED and what was AGREED, ' +
        'without attributing any of it. If a point only makes sense knowing who ' +
        'said it, leave it out.');
}

/* Returns the summary text, or '' when there is nothing worth storing. THROWS on a real
   failure -- a refused key, a 500 -- because the sync has to tell those apart from "this
   call had nothing to summarise" and an empty string cannot say which happened. */
async function summarise({ transcript, client, company, when, minutes }) {
  const text = String(transcript || '').trim();
  if (!text) return '';
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set');

  const res = await fetch(CLAUDE_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 900,
      system: buildSystem(text),
      messages: [{ role: 'user', content: JSON.stringify({
        client: client || '', company: company || '', when: when || '',
        minutes: minutes || null,
        transcript: text.slice(0, MAX_CHARS)
      }) }]
    })
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error('Claude refused it (' + res.status + ') ' + body.slice(0, 160));
  }
  const data = await res.json();
  const out = (data && Array.isArray(data.content) ? data.content : [])
    .map(function (p) { return p && p.type === 'text' ? p.text : ''; })
    .join('')
    .trim();
  return out;
}

module.exports = { summarise, isAttributed, buildSystem, MODEL, MAX_CHARS };
