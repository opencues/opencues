---
ignore:
  - the
  - a
  - an
  - is
  - are
  - was
  - were
  - be
  - been
  - to
  - of
  - in
  - at
  - on
  - for
  - and
  - but
  - or
  - not
  - it

sources:
  grammar:
    scope: words
    parser: alternatives
    prompt: |
      For each numbered word, suggest 2-3 alternative words that could replace it in context.
      Keep the same part of speech and meaning. Format: INDEX: alt1, alt2, alt3
      Only include words where meaningful alternatives exist. Skip function words.
---
