---
name: email
id: 9
title: Write a clear email — greeting, purpose, details, sign-off
---

Practise the four moves of a clear, courteous email: open with a
greeting, say why you're writing in the first line, give the details or
your ask, then close with a sign-off. This kata is host-agnostic — it
works anywhere you type (a browser compose box, an editor, the shell) and
watches only the text you write, so just compose the email and the
coaching line follows along.

## Step 1 — greet the recipient
Open the email with a greeting that names who it's for — for example
"Hi Sarah," or "Dear Dr. Okafor,".
coach:
  - Empty buffer → suggest opening with a greeting, e.g. "Hi Sarah,"
  - They typed a line but it has no recipient (just "Hi," or "Hello") → nudge them to name the person, e.g. "Hi Sarah,"
  - The buffer opens with a greeting that names a recipient → STEP_DONE
  - They clearly started the body/purpose without a greeting → tell them an email reads warmer with a greeting first; suggest adding one

## Step 2 — state your purpose
On the next line, say WHY you're writing in a single clear sentence —
the reason should be obvious from the opening line alone (for example
"I'm writing to ask for a two-week extension on the report.").
coach:
  - Only the greeting so far → prompt them for the reason they're writing, in one sentence
  - They wrote a purpose line that states why they're writing → STEP_DONE
  - Their opening sentence is vague or buries the point ("Hope you're well, so anyway…") → nudge them to lead with the actual reason
  - They jumped straight into dense details without stating the purpose → tell them to add a one-line "why I'm writing" up top first

## Step 3 — give the details or the ask
Add the specifics: the context, the request, or what you need the reader
to do. Keep it to the point.
coach:
  - Only greeting + purpose so far → ask them to add the supporting detail or the specific request
  - They added a sentence or two of detail / a concrete ask after the purpose → STEP_DONE
  - The detail contradicts or restates the purpose with nothing new → nudge them to add the specifics (a date, a number, the action they want)

## Step 4 — sign off
Close with a courteous sign-off and your name — for example "Best
regards," on one line and your name on the next.
coach:
  - Body is written but there's no closing yet → suggest a sign-off like "Best regards," followed by their name
  - They added a sign-off phrase but no name → tell them to add their name under it
  - The email ends with a sign-off and a name → STEP_DONE
  - They submitted the email (buffer cleared after Enter) with a body present → they sent it: STEP_DONE
