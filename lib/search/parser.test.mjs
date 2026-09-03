// Test suite for the search query parser. Written before the parser, and covering every
// row of the modifier table plus every rule and named case in the specification.
//
// Run: node lib/search/parser.test.mjs
// The parser is a UMD file so index.html can load it with a plain <script> — node sees
// it as CommonJS, hence the default import.
import parser from './parser.js';
const { parseSearchQuery } = parser;

let passed = 0, failed = 0;
const fails = [];
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function t(name, fn) {
  try { fn(); passed++; }
  catch (e) { failed++; fails.push(name + '\n    ' + e.message); }
}
function is(actual, expected, what) {
  if (!eq(actual, expected)) {
    throw new Error((what ? what + ': ' : '') + 'expected ' + JSON.stringify(expected)
      + ' but got ' + JSON.stringify(actual));
  }
}
// A fixed clock, so "today" and "the most recent August" are not a function of when the
// suite happens to run.
const NOW = new Date('2026-09-03T10:30:00Z');
const OPTS = { now: NOW, timezone: 'UTC' };
const P = (q, o) => parseSearchQuery(q, { ...OPTS, ...(o || {}) });

// ── free text ────────────────────────────────────────────────────────────────
t('plain words become words', () => {
  is(P('marketing report').text.words, ['marketing', 'report']);
});
t('raw is preserved verbatim', () => {
  is(P('  marketing  ').raw, '  marketing  ');
});
t('empty query parses to an empty AST rather than throwing', () => {
  const a = P('');
  is(a.text.words, []); is(a.filters.in, []); is(a.partial, null);
});

// ── the named cases from the specification ───────────────────────────────────
t('case: marketing -report', () => {
  const a = P('marketing -report');
  is(a.text.words, ['marketing']);
  is(a.exclude.words, ['report']);
});
t('case: "marketing report" in:#a from:@b', () => {
  const a = P('"marketing report" in:#a from:@b');
  is(a.text.phrases, ['marketing report']);
  is(a.text.words, []);
  is(a.filters.in, ['#a']);
  is(a.filters.from, ['@b']);
});
t('case: rep* is a prefix (3+ characters)', () => {
  const a = P('rep*');
  is(a.text.prefixes, ['rep']);
  is(a.text.words, []);
});
t('case: re* is too short, so it is a literal word', () => {
  const a = P('re*');
  is(a.text.prefixes, []);
  is(a.text.words, ['re']);
});
t('case: from:@a from:@b repeats and ORs', () => {
  is(P('from:@a from:@b').filters.from, ['@a', '@b']);
});
t('case: -in:#general negates a modifier', () => {
  const a = P('-in:#general');
  is(a.filters.in, []);
  is(a.excludeFilters.in, ['#general']);
});
t('case: during:august resolves to a range', () => {
  const r = P('during:august').filters.dateRange;
  is(r.start, '2026-08-01T00:00:00.000Z');
  is(r.end, '2026-09-01T00:00:00.000Z');
});
t('case: has::eyes: keeps the emoji, colons and all', () => {
  is(P('has::eyes:').filters.has, [':eyes:']);
});
t('case: unterminated "quote takes the rest as the phrase', () => {
  const a = P('unterminated "quote');
  is(a.text.words, ['unterminated']);
  is(a.text.phrases, ['quote']);
});
t('case: foo:bar baz — unknown key is free text', () => {
  const a = P('foo:bar baz');
  is(a.text.words, ['foo:bar', 'baz']);
});

// ── every row of the modifier table ──────────────────────────────────────────
t('in: takes channels and users', () => {
  const a = P('in:#team in:@sara');
  is(a.filters.in, ['#team', '@sara']);
});
t('from:', () => is(P('from:@sara').filters.from, ['@sara']));
t('with:', () => is(P('with:@sara').filters.with, ['@sara']));
t('creator:', () => is(P('creator:@sara').filters.creator, ['@sara']));
t('has: pin, link, file and emoji', () => {
  is(P('has:pin has:link has:file has::tada:').filters.has, ['pin', 'link', 'file', ':tada:']);
});
t('hasmy: takes an emoji', () => is(P('hasmy::eyes:').filters.hasMy, [':eyes:']));
t('is: saved, thread, pinned', () => {
  is(P('is:saved is:thread is:pinned').filters.is, ['saved', 'thread', 'pinned']);
});
t('every negatable modifier can be negated', () => {
  const a = P('-in:#a -from:@b -with:@c -creator:@d -has:pin -hasmy::eyes: -is:thread');
  is(a.excludeFilters.in, ['#a']);
  is(a.excludeFilters.from, ['@b']);
  is(a.excludeFilters.with, ['@c']);
  is(a.excludeFilters.creator, ['@d']);
  is(a.excludeFilters.has, ['pin']);
  is(a.excludeFilters.hasMy, [':eyes:']);
  is(a.excludeFilters.is, ['thread']);
});
t('dates are not negatable — a negated date is free text', () => {
  const a = P('-before:2026-01-01');
  is(a.filters.dateRange, null);
  is(a.text.words, ['-before:2026-01-01']);
});

// ── parser rules ─────────────────────────────────────────────────────────────
t('modifier keys are case-insensitive', () => {
  is(P('FROM:@sara IN:#team').filters.from, ['@sara']);
  is(P('FROM:@sara IN:#team').filters.in, ['#team']);
});
t('modifier values keep their case', () => {
  is(P('from:@Sara').filters.from, ['@Sara']);
});
t('a quoted phrase is one unit, in order', () => {
  is(P('"q3 report" marketing').text.phrases, ['q3 report']);
});
t('a negated phrase excludes it', () => {
  const a = P('-"q3 report"');
  is(a.exclude.phrases, ['q3 report']);
  is(a.text.phrases, []);
});
t('a modifier value may be quoted, for names with spaces', () => {
  is(P('from:"Sara Jones"').filters.from, ['Sara Jones']);
});
t('no leading or infix wildcards', () => {
  const a = P('*rep re*ort');
  is(a.text.words, ['*rep', 're*ort']);
  is(a.text.prefixes, []);
});
t('empty modifier value is dropped and recorded as partial', () => {
  const a = P('from:');
  is(a.filters.from, []);
  is(a.partial, { key: 'from', value: '' });
});
t('a partial value is offered for typeahead too', () => {
  is(P('marketing in:tea').partial, { key: 'in', value: 'tea' });
});
t('a completed modifier leaves no partial', () => {
  is(P('in:#team ').partial, null);
});
t('different modifiers AND, repeats OR, negations AND-NOT', () => {
  const a = P('from:@a from:@b in:#x -from:@c');
  is(a.filters.from, ['@a', '@b']);
  is(a.filters.in, ['#x']);
  is(a.excludeFilters.from, ['@c']);
});

// ── dates ────────────────────────────────────────────────────────────────────
t('on: is a single day, half-open', () => {
  const r = P('on:2026-08-14').filters.dateRange;
  is(r.start, '2026-08-14T00:00:00.000Z');
  is(r.end, '2026-08-15T00:00:00.000Z');
});
t('after: sets the start', () => {
  is(P('after:2026-08-14').filters.dateRange.start, '2026-08-14T00:00:00.000Z');
});
t('before: sets the end', () => {
  is(P('before:2026-08-14').filters.dateRange.end, '2026-08-14T00:00:00.000Z');
});
t('after: and before: combine into one range', () => {
  const r = P('after:2026-01-01 before:2026-02-01').filters.dateRange;
  is(r.start, '2026-01-01T00:00:00.000Z');
  is(r.end, '2026-02-01T00:00:00.000Z');
});
t('today uses the requesting timezone', () => {
  const r = P('on:today', { timezone: 'Asia/Kolkata' }).filters.dateRange;
  // 2026-09-03 in +05:30 begins at 18:30 UTC the day before
  is(r.start, '2026-09-02T18:30:00.000Z');
  is(r.end, '2026-09-03T18:30:00.000Z');
});
t('yesterday is the day before that', () => {
  const r = P('on:yesterday').filters.dateRange;
  is(r.start, '2026-09-02T00:00:00.000Z');
  is(r.end, '2026-09-03T00:00:00.000Z');
});
t('a month name abbreviates', () => {
  const r = P('during:aug').filters.dateRange;
  is(r.start, '2026-08-01T00:00:00.000Z');
});
t('a month that has not started yet resolves to last year', () => {
  // October has not started on 3 September 2026
  const r = P('during:october').filters.dateRange;
  is(r.start, '2025-10-01T00:00:00.000Z');
  is(r.end, '2025-11-01T00:00:00.000Z');
});
t('a bare year is the whole year', () => {
  const r = P('during:2026').filters.dateRange;
  is(r.start, '2026-01-01T00:00:00.000Z');
  is(r.end, '2027-01-01T00:00:00.000Z');
});
t('an unparseable date is free text, not a throw', () => {
  const a = P('before:someday');
  is(a.filters.dateRange, null);
  is(a.text.words, ['before:someday']);
});

// ── shape ────────────────────────────────────────────────────────────────────
t('the AST has every documented key, even when empty', () => {
  const a = P('x');
  is(Object.keys(a).sort(), ['exclude', 'excludeFilters', 'filters', 'partial', 'raw', 'text']);
  is(Object.keys(a.filters).sort(),
     ['creator', 'dateRange', 'has', 'hasMy', 'in', 'is', 'with', 'from'].sort());
});

console.log(`${passed} passed, ${failed} failed`);
if (fails.length) { console.log('\nFAILURES:'); fails.forEach(f => console.log('  ✗ ' + f)); }
process.exit(failed ? 1 : 0);
