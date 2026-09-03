// Search query parser — turns a raw search string into a structured AST.
//
// Pure: no database, no network, no DOM. It is imported by the node test suite and loaded
// into the browser by index.html, so the typeahead and (later) the query compiler read the
// same grammar from the same file rather than each growing their own dialect.
//
// Grammar:
//   query    := term*
//   term     := modifier | phrase | word
//   modifier := "-"? KEY ":" value
//   phrase   := '"' .+ '"'
//   word     := [^\s"]+ ("*")?
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.GiantSearchParser = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  const LIST_KEYS = ['in', 'from', 'with', 'creator', 'has', 'hasmy', 'is'];
  const DATE_KEYS = ['before', 'after', 'on', 'during'];
  // hasmy is spelled hasMy on the AST, because that is how the rest of the app reads.
  const AST_KEY = { hasmy: 'hasMy' };
  const MONTHS = ['january','february','march','april','may','june',
                  'july','august','september','october','november','december'];
  const MIN_PREFIX = 3;   // "re*" is not a prefix search; "rep*" is

  const emptyAst = (raw) => ({
    text: { words: [], phrases: [], prefixes: [] },
    exclude: { words: [], phrases: [] },
    filters: { in: [], from: [], with: [], creator: [], has: [], hasMy: [], is: [], dateRange: null },
    excludeFilters: { in: [], from: [], with: [], creator: [], has: [], hasMy: [], is: [] },
    partial: null,
    raw: raw
  });

  // ── tokenizer ──────────────────────────────────────────────────────────────
  // Splits on whitespace, except inside quotes. A quote that is never closed takes the
  // rest of the string rather than throwing: people search while they are still typing.
  function tokenize(raw) {
    const out = [];
    const s = String(raw == null ? '' : raw);
    let i = 0;
    while (i < s.length) {
      if (/\s/.test(s[i])) { i++; continue; }
      let tok = '';
      let sawQuote = false;
      while (i < s.length && !/\s/.test(s[i])) {
        if (s[i] === '"') {
          sawQuote = true;
          tok += '"';
          i++;
          while (i < s.length && s[i] !== '"') { tok += s[i]; i++; }
          if (i < s.length) { tok += '"'; i++; }        // closing quote
          else { tok += '"'; }                          // unterminated: close it ourselves
          continue;
        }
        tok += s[i]; i++;
      }
      if (tok) out.push({ text: tok, quoted: sawQuote });
    }
    return out;
  }

  const unquote = (v) => {
    const m = String(v).match(/^"([\s\S]*)"$/);
    return m ? m[1] : v;
  };

  // ── dates ──────────────────────────────────────────────────────────────────
  // Everything resolves to a half-open UTC range [start, end). Only today/yesterday are
  // relative to the requesting user's timezone -- a calendar date means the same day
  // wherever it is typed, but "today" does not.
  function tzParts(date, timeZone) {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
    });
    const [y, m, d] = fmt.format(date).split('-').map(Number);
    return { y, m, d };
  }
  // How far ahead of UTC that zone is at that instant. Comparing only the DATE parts is
  // not enough -- in +05:30 the local date and the UTC date are the same for most of the
  // day, so a date-only comparison finds no offset at all and midnight lands in the wrong
  // place by five and a half hours.
  function tzOffsetMs(date, timeZone) {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    const p = {};
    dtf.formatToParts(date).forEach(x => { p[x.type] = x.value; });
    const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second);
    return asUtc - date.getTime();
  }
  // The UTC instant at which a local calendar day begins in that timezone.
  function localDayStartUtc(y, m, d, timeZone) {
    const guess = Date.UTC(y, m - 1, d, 0, 0, 0);
    let ms = guess - tzOffsetMs(new Date(guess), timeZone);
    // Once more, for the days a zone changes its offset: the first guess can land on the
    // wrong side of the change.
    ms = guess - tzOffsetMs(new Date(ms), timeZone);
    return new Date(ms);
  }
  const iso = (d) => new Date(d).toISOString();
  const addDaysUtc = (d, n) => new Date(new Date(d).getTime() + n * 86400000);

  // Returns { start, end } as Dates, or null when the value is not a date at all.
  function resolveDate(rawValue, key, now, timeZone) {
    const value = String(rawValue || '').trim().toLowerCase();
    if (!value) return null;

    if (value === 'today' || value === 'yesterday') {
      const p = tzParts(now, timeZone);
      let start = localDayStartUtc(p.y, p.m, p.d, timeZone);
      if (value === 'yesterday') start = localDayStartUtc(p.y, p.m, p.d - 1, timeZone);
      const nextP = tzParts(addDaysUtc(start, 1), timeZone);
      const end = localDayStartUtc(nextP.y, nextP.m, nextP.d, timeZone);
      return { start, end };
    }
    const ymd = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (ymd) {
      const start = new Date(Date.UTC(+ymd[1], +ymd[2] - 1, +ymd[3]));
      return { start, end: addDaysUtc(start, 1) };
    }
    const year = value.match(/^(\d{4})$/);
    if (year) {
      return { start: new Date(Date.UTC(+year[1], 0, 1)), end: new Date(Date.UTC(+year[1] + 1, 0, 1)) };
    }
    const monthIdx = MONTHS.findIndex(m => m === value || m.slice(0, 3) === value);
    if (monthIdx >= 0) {
      // The most recent one that has already started: in September, "october" is last
      // year's October, not one that has not happened.
      const nowY = now.getUTCFullYear();
      const y = (monthIdx <= now.getUTCMonth()) ? nowY : nowY - 1;
      return { start: new Date(Date.UTC(y, monthIdx, 1)), end: new Date(Date.UTC(y, monthIdx + 1, 1)) };
    }
    return null;
  }

  function parseSearchQuery(raw, options) {
    const opts = options || {};
    const now = opts.now ? new Date(opts.now) : new Date();
    const timeZone = opts.timezone || 'UTC';
    const ast = emptyAst(raw == null ? '' : String(raw));
    const tokens = tokenize(raw);
    let dateStart = null, dateEnd = null;

    tokens.forEach((tok, idx) => {
      let text = tok.text;
      let negated = false;
      if (text.length > 1 && text[0] === '-') { negated = true; text = text.slice(1); }

      // A phrase, quoted from the first character: one unit, matched in order.
      if (text[0] === '"') {
        const phrase = unquote(text).trim();
        if (!phrase) return;
        (negated ? ast.exclude.phrases : ast.text.phrases).push(phrase);
        return;
      }

      const colon = text.indexOf(':');
      const key = colon > 0 ? text.slice(0, colon).toLowerCase() : null;
      const isListKey = key && LIST_KEYS.includes(key);
      const isDateKey = key && DATE_KEYS.includes(key);

      if (isListKey || isDateKey) {
        const value = unquote(text.slice(colon + 1));

        // Dates are not negatable. A negated one is not a filter at all, so it stays as
        // the text the person typed rather than silently doing nothing.
        if (isDateKey && negated) { ast.text.words.push(tok.text); return; }

        if (!value) {
          // Nothing after the colon yet. Dropped as a filter, but remembered so the
          // typeahead knows what is being asked for.
          ast.partial = { key, value: '' };
          return;
        }

        if (isDateKey) {
          const range = resolveDate(value, key, now, timeZone);
          // An unparseable date is free text. Throwing on it would take the whole query
          // down over a typo.
          if (!range) { ast.text.words.push(tok.text); return; }
          if (key === 'on' || key === 'during') {
            dateStart = range.start; dateEnd = range.end;
          } else if (key === 'after') {
            dateStart = range.start;
          } else if (key === 'before') {
            dateEnd = range.start;
          }
          return;
        }

        const astKey = AST_KEY[key] || key;
        (negated ? ast.excludeFilters : ast.filters)[astKey].push(value);
        // The last modifier in the string is the one being typed, so its value is what a
        // typeahead should complete -- until a space says it is finished.
        const lastToken = idx === tokens.length - 1;
        const trailingSpace = /\s$/.test(String(raw || ''));
        if (lastToken && !trailingSpace && !negated) ast.partial = { key, value };
        else if (lastToken && trailingSpace) ast.partial = null;
        return;
      }

      // Free text. A trailing * is a prefix search, but only on something long enough to
      // be worth one -- "re*" would match most of the workspace.
      if (/\*$/.test(text) && !/^\*/.test(text) && text.indexOf('*') === text.length - 1) {
        const stem = text.slice(0, -1);
        if (stem.length >= MIN_PREFIX) {
          if (!negated) { ast.text.prefixes.push(stem); return; }
          ast.exclude.words.push(stem); return;
        }
        (negated ? ast.exclude.words : ast.text.words).push(stem);
        return;
      }
      (negated ? ast.exclude.words : ast.text.words).push(text);
    });

    if (dateStart || dateEnd) {
      ast.filters.dateRange = {
        start: dateStart ? iso(dateStart) : null,
        end: dateEnd ? iso(dateEnd) : null
      };
    }
    return ast;
  }

  return { parseSearchQuery, tokenize, resolveDate, MIN_PREFIX };
});
