# Languages

The site interface is available in seven languages. **The interface only** —
never the editorial content.

| | |
|---|---|
| Full | English, Afrikaans, isiXhosa, isiZulu |
| Partial | Sesotho, Setswana, Sepedi |

## What is translated, and what is deliberately not

Navigation, buttons, section headings, form labels, the consent bar. Not
articles, not directory profiles, not shout-outs.

Those are written by people in the language they chose, and machine-translating
somebody's story misrepresents them. A reader can navigate the whole site in
their own language and still read each piece as it was written.

## South African Sign Language is not in this file, and never will be

**SASL is not a written language.** There is no correct string to put in a
dictionary for it, and anything that looked like one would be wrong.

SASL is on the site as **signed video with captions** — `sasl_videos`, admin →
**SASL Videos**. One recording per article or standing page, made by a signer.
Nothing about it is generated.

### Captions are required to publish, and become the transcript

A signed video with no captions leaves out every deaf person who does not sign
— a large group that signed video alone excludes entirely — and everybody
watching with the sound off. So publishing without them is refused, on both the
create call and the publish call. (Saving a draft without them is fine.)

The caption text is stored as WebVTT in the database rather than as an uploaded
`.vtt` file: no new upload type, no bucket content-type to get wrong, and
captions can be corrected in the admin without re-uploading anything.

**It is rendered as a readable transcript, not as a `<track>`.** The videos are
platform embeds — YouTube and the rest — and a `<track>` cannot be attached to
somebody else's iframe, so the stored VTT could never drive the player's own
captions. That is not a consolation prize: a transcript works with a screen
reader, can be copied and translated, and unlike a caption track a search
engine can read it.

The player loads nothing until it is asked to. An iframe that loads on sight is
a third-party request, and a cost, for every reader whether they watch or not.

## Partial languages are partial on purpose

Sesotho, Setswana and Sepedi carry the navigation and the common interface
words. Everything else falls through to English, one key at a time — which is
exactly what `t()` and `hasTranslation()` are built to do.

That is a deliberate stop, not an unfinished job. The keys left out are the
ones where a confident-looking wrong word does real damage: the **Deaf
Community** section, SASL, and the legal, refund and privacy wording. Guessing
at Deaf terminology in a language I cannot verify would be worse than showing
the English — and this publication of all publications should not get that
wrong.

## None of these are certified translations

Every non-English string here is a careful translation, **not a certified
one**. UI wording is easy to get subtly wrong, and a first-language speaker
should review each language before launch. They can fill in the missing keys at
the same time.

This is the single outstanding item on the feature.

## How it degrades

Three separate fallbacks, and they matter:

1. **A missing key falls back to English**, per key, not per language.
2. **An untranslated key leaves the markup alone.** `applyLanguage()` writes
   into elements that already contain correct English. Without the
   `hasTranslation()` check, a key nobody added would not degrade to that
   English — it would actively replace it with the raw dotted key, so the nav
   would read "NAV.MEMBERS". That fails silently in every language at once.
3. **A CMS override always wins.** An admin's deliberate rewording is marked
   `data-cms-applied` and never overwritten, so it is not silently undone on
   every page load. The trade-off is that the reworded heading stays in the
   language it was written in.

`<html lang>` is set from the choice, so screen readers use the right
pronunciation.

## The trap in `applyLanguage()`

It sets `textContent`, which **deletes child elements**. So an element may only
be tagged `data-i18n` if it is a leaf.

That is why the mega-menu's group buttons carry their label in an inner
`<span class="nav-trigger-label">` rather than on the button: the button also
contains the chevron, and tagging it directly would delete the chevron on every
language change.

## A regression this fixed

The D2 mega-menu rewrote the navigation and **dropped `data-i18n` from every
nav item**. The language picker kept working and the nav quietly stopped
translating — 18 tagged elements left on the whole page. It is back to 59, and
now covers the group names, every item, every item description, and the panels'
accessible names.

## Adding a language

Add a block to `I18N` in `i18n.js` with a `_label`. The picker builds itself
from the object's keys, so nothing else needs touching. Partial is fine and
preferred over guessed.

## Files

| | |
|---|---|
| `i18n.js` | The dictionary, the picker, and the apply logic. |
| `unplug-magazine.html` | `data-i18n` / `data-i18n-aria` attributes, and the SASL player. |
| `unplug-backend/db/migrations/153_sasl_videos.sql` | `sasl_videos`. |
| `unplug-backend/src/routes/sasl.js` | Public lookup and admin CRUD. |
| `unplug-backend/test/sasl.test.js` | 15 tests against a real PostgreSQL. |
| `unplug-admin-dashboard.html` | The SASL Videos screen. |
