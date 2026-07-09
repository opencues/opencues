import { describe, expect, it } from 'vitest';
import {
  escapeNotesHtml,
  unescapeNotesEntities,
  normalizePlaintext,
  bodyLooksAttachmentBearing,
  splitBodyLines,
  spliceLineIntoBody,
  spliceLinesIntoBody,
} from './html-text';

// Real body captured from Notes.app during the Phase 0 spike
// (integrations/apple-notes/NOTES-PLATFORM.md). Note the SEMICOLON-LESS
// entity forms — that is what Notes actually serializes.
const SPIKE_BODY =
  '<div>spike test note</div>\n' +
  '<div>plain ascii line</div>\n' +
  '<div>entities: &lttag&gt &amp &quotquotes&quot \'single\' — dash</div>\n' +
  '<div>emoji: 😀 éèü</div>\n' +
  '<div>what is the capital of france _</div>\n' +
  '<div><br></div>\n' +
  '<div>line after blank line</div>\n';

const SPIKE_PLAINTEXT_LINES = [
  'spike test note',
  'plain ascii line',
  'entities: <tag> & "quotes" \'single\' — dash',
  'emoji: 😀 éèü',
  'what is the capital of france _',
  '',
  'line after blank line',
];

describe('escapeNotesHtml', () => {
  it('escapes the standard trio with semicolons', () => {
    expect(escapeNotesHtml('<tag> & "q"')).toBe('&lt;tag&gt; &amp; "q"');
  });
  it('leaves emoji, accents and dashes literal', () => {
    expect(escapeNotesHtml('😀 éèü — dash')).toBe('😀 éèü — dash');
  });
});

describe('unescapeNotesEntities', () => {
  it('decodes Notes semicolon-less forms', () => {
    expect(unescapeNotesEntities('&lttag&gt &amp &quotq&quot')).toBe('<tag> & "q"');
  });
  it('decodes standard semicolon forms', () => {
    expect(unescapeNotesEntities('&lt;tag&gt; &amp; &quot;q&quot;')).toBe('<tag> & "q"');
  });
  it('does not double-decode &amp;lt;', () => {
    // literal "&lt;" typed by a user round-trips as &amp;lt; → "&lt;"
    expect(unescapeNotesEntities('&amp;lt;')).toBe('&lt;');
  });
});

describe('normalizePlaintext', () => {
  it('normalizes CRLF and CR to LF', () => {
    expect(normalizePlaintext('a\r\nb\rc\n')).toBe('a\nb\nc\n');
  });
});

describe('bodyLooksAttachmentBearing', () => {
  it('flags img/object/attachment/data: bodies', () => {
    expect(bodyLooksAttachmentBearing('<div><img src="x.png"></div>')).toBe(true);
    expect(bodyLooksAttachmentBearing('<div><object data="y"></object></div>')).toBe(true);
    expect(bodyLooksAttachmentBearing('<div>x</div><attachment id="1"/>')).toBe(true);
    expect(bodyLooksAttachmentBearing('<div>src=data:image/png;base64,AAAA</div>')).toBe(true);
  });
  it('passes the plain spike body', () => {
    expect(bodyLooksAttachmentBearing(SPIKE_BODY)).toBe(false);
  });
});

describe('splitBodyLines', () => {
  it('extracts plain text per line matching Notes plaintext', () => {
    const lines = splitBodyLines(SPIKE_BODY);
    expect(lines.map(l => l.text)).toEqual(SPIKE_PLAINTEXT_LINES);
  });
  it('treats <br> divs as empty lines', () => {
    expect(splitBodyLines('<div><br></div>')[0].text).toBe('');
  });
  it('strips inline formatting tags when extracting text', () => {
    const lines = splitBodyLines('<div>make <b>this</b> bold</div>');
    expect(lines[0].text).toBe('make this bold');
  });
});

describe('spliceLineIntoBody', () => {
  it('replaces exactly-one matching line, preserving all others byte-for-byte', () => {
    const out = spliceLineIntoBody(
      SPIKE_BODY,
      'what is the capital of france _',
      'what is the capital of france Paris',
    );
    expect(out).toBe(SPIKE_BODY.replace(
      '<div>what is the capital of france _</div>',
      '<div>what is the capital of france Paris</div>',
    ));
    // the semicolon-less entity line is untouched
    expect(out).toContain('&lttag&gt &amp &quotquotes&quot');
  });

  it('matches a line whose plaintext contains entities (encoding-mismatch case)', () => {
    const out = spliceLineIntoBody(
      SPIKE_BODY,
      'entities: <tag> & "quotes" \'single\' — dash',
      'replaced',
    );
    expect(out).toContain('<div>replaced</div>');
  });

  it('escapes the new line on write', () => {
    const out = spliceLineIntoBody(SPIKE_BODY, 'plain ascii line', 'a < b & c');
    expect(out).toContain('<div>a &lt; b &amp; c</div>');
  });

  it('returns null on zero matches (stale buffer)', () => {
    expect(spliceLineIntoBody(SPIKE_BODY, 'no such line', 'x')).toBeNull();
  });

  it('returns null on multiple matches (ambiguous)', () => {
    const dup = '<div>same</div>\n<div>same</div>\n';
    expect(spliceLineIntoBody(dup, 'same', 'x')).toBeNull();
  });

  it('never rebuilds the body — a failed splice leaves no output at all', () => {
    // formatting split across nodes within the line still extracts, but a
    // duplicate elsewhere forces the abort path
    const body = '<div>ask <i>it</i> _</div>\n<div>ask it _</div>\n';
    expect(spliceLineIntoBody(body, 'ask it _', 'ask it done')).toBeNull();
  });
});

describe('spliceLinesIntoBody', () => {
  const BODY =
    '<div>title</div>\n' +
    '<div>draft an email _</div>\n' +
    '<div>footer</div>\n';

  it('replaces one line with a multi-line answer', () => {
    const out = spliceLinesIntoBody(
      BODY,
      ['draft an email _'],
      ['Dear landlord,', '', 'Please reduce my rent.'],
    );
    expect(out).toBe(
      '<div>title</div>\n' +
      '<div>Dear landlord,</div>\n' +
      '<div><br></div>\n' +
      '<div>Please reduce my rent.</div>\n' +
      '<div>footer</div>\n',
    );
  });

  it('replaces a consecutive multi-line run', () => {
    const body = '<div>a</div>\n<div>b</div>\n<div>c</div>\n<div>d</div>\n';
    const out = spliceLinesIntoBody(body, ['b', 'c'], ['bc']);
    expect(out).toBe('<div>a</div>\n<div>bc</div>\n<div>d</div>\n');
  });

  it('requires the run to be consecutive', () => {
    const body = '<div>a</div>\n<div>x</div>\n<div>b</div>\n';
    expect(spliceLinesIntoBody(body, ['a', 'b'], ['ab'])).toBeNull();
  });

  it('aborts when the run appears twice and no expectedStart is given', () => {
    const body = '<div>a</div>\n<div>b</div>\n<div>a</div>\n<div>b</div>\n';
    expect(spliceLinesIntoBody(body, ['a', 'b'], ['ab'])).toBeNull();
  });

  it('expectedStart disambiguates a duplicated run (repeated cue lines)', () => {
    // Live failure 2026-07-09: a note holding several identical
    // "Draft an email _" attempts made every fill abort as ambiguous.
    const body = '<div>q _</div>\n<div>x</div>\n<div>q _</div>\n';
    const out = spliceLinesIntoBody(body, ['q _'], ['q 42'], 2);
    expect(out).toBe('<div>q _</div>\n<div>x</div>\n<div>q 42</div>\n');
    const outFirst = spliceLinesIntoBody(body, ['q _'], ['q 42'], 0);
    expect(outFirst).toBe('<div>q 42</div>\n<div>x</div>\n<div>q _</div>\n');
  });

  it('expectedStart that is not one of the matches still aborts', () => {
    const body = '<div>q _</div>\n<div>x</div>\n<div>q _</div>\n';
    expect(spliceLinesIntoBody(body, ['q _'], ['q 42'], 1)).toBeNull();
  });

  it('a unique match wins even when expectedStart points elsewhere (stale diff)', () => {
    const body = '<div>a</div>\n<div>q _</div>\n<div>c</div>\n';
    const out = spliceLinesIntoBody(body, ['q _'], ['q 42'], 0);
    expect(out).toBe('<div>a</div>\n<div>q 42</div>\n<div>c</div>\n');
  });

  it('aborts on an empty old run', () => {
    expect(spliceLinesIntoBody(BODY, [], ['x'])).toBeNull();
  });

  it('drops the phantom trailing empty line from a terminal-\\n diff (whole-note rewrite)', () => {
    // plaintext "title\ncue _\n".split('\n') = ['title','cue _',''] but the
    // body has only two divs — the trailing '' is a phantom. A rewrite
    // whose diff region reaches the end carries it on both sides.
    const body = '<div>title</div>\n<div>cue _</div>\n';
    const out = spliceLinesIntoBody(
      body,
      ['cue _', ''],
      ['Dear Council,', '', 'Please stop.', ''],
    );
    expect(out).toBe(
      '<div>title</div>\n' +
      '<div>Dear Council,</div>\n' +
      '<div><br></div>\n' +
      '<div>Please stop.</div>\n',
    );
  });

  it('a REAL empty last line still matches after one phantom drop', () => {
    // plaintext "a\nb\n\n" → ['a','b','',''] — body has a real <br> div.
    const body = '<div>a</div>\n<div>b</div>\n<div><br></div>\n';
    const out = spliceLinesIntoBody(body, ['b', '', ''], ['B', '', '']);
    expect(out).toBe('<div>a</div>\n<div>B</div>\n<div><br></div>\n');
  });

  it('a styled anchor line survives a pure-insertion splice (leading anchor)', () => {
    // diffLines widens a pure insertion with the preceding line as an
    // anchor: old ['Heading'] → new ['Heading', 'inserted']. The anchor's
    // text didn't change, so its ORIGINAL raw fragment (with styling)
    // must be reused — not re-escaped into a plain <div>.
    const body = '<div><b>Heading</b></div>\n<div>tail</div>\n';
    const out = spliceLinesIntoBody(body, ['Heading'], ['Heading', 'inserted']);
    expect(out).toBe(
      '<div><b>Heading</b></div>\n' +
      '<div>inserted</div>\n' +
      '<div>tail</div>\n',
    );
  });

  it('a styled anchor line survives as a trailing anchor too', () => {
    // Insertion at the very top widens FORWARD: old ['Styled'] →
    // new ['inserted', 'Styled'] — the unchanged suffix keeps its raw.
    const body = '<div><i>Styled</i></div>\n<div>tail</div>\n';
    const out = spliceLinesIntoBody(body, ['Styled'], ['inserted', 'Styled']);
    expect(out).toBe(
      '<div>inserted</div>\n' +
      '<div><i>Styled</i></div>\n' +
      '<div>tail</div>\n',
    );
  });

  it('changed lines are still freshly escaped when edges are unchanged', () => {
    // Middle line changes between two unchanged styled edges: edges keep
    // raw fragments, the changed line gets standard escaping.
    const body =
      '<div><b>top</b></div>\n<div>old & busted</div>\n<div><i>bottom</i></div>\n';
    const out = spliceLinesIntoBody(
      body,
      ['top', 'old & busted', 'bottom'],
      ['top', 'new & shiny <ok>', 'bottom'],
    );
    expect(out).toBe(
      '<div><b>top</b></div>\n' +
      '<div>new &amp; shiny &lt;ok&gt;</div>\n' +
      '<div><i>bottom</i></div>\n',
    );
  });
});
