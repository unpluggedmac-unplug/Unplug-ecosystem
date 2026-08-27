# The main menu

Sixteen items in one row asked every visitor to already know what "Top 10"
meant. They are now five groups, each with a one-line description of what is
behind it.

| Group | What is in it |
|---|---|
| Read | Home, Articles, Gallery, Videos |
| Community | Directory, Members, Deaf Community |
| Take Part | Nominate, Competitions, Top 10 |
| Business | Marketplace, Investor Projects |
| About | About, Contact, Editions |

Nominate is in **Take Part only**. An item that appears in two groups looks
like two different pages to somebody scanning a menu.

## It is a disclosure pattern, not `role="menu"`

`role="menu"` is for application menus — the Edit menu in a word processor. Put
it on site navigation and a screen reader announces a menu the user then cannot
drive the way that announcement promised. This is a `<button aria-expanded>`
controlling a panel, which is what it actually is.

## The panel items are real links

`<a href>`, not buttons. A link can be opened in a new tab, copied, and pulled
up in a screen reader's list of links; a button can do none of that.

That meant fixing the shared `[data-page]` handler, which called
`preventDefault()` on **every** click — so ctrl-click, middle-click and
shift-click were all silently swallowed sitewide. Modified clicks now fall
through to the browser:

```js
if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
```

## Keyboard

Enter/Space opens, Escape closes **and returns focus to the trigger that opened
it**, Left/Right move between groups and wrap. Only one panel is open at a time,
and clicking outside closes it.

## Unlisted pages, and the empty-heading trap

Page Visibility hides `[data-page]` links. A group whose items are *all*
unlisted would otherwise have left a heading that opens an empty panel, so
`hideEmptyGroups()` removes the group itself. Unlist one item and the group
stays, minus that item.

## Mobile

Under 768px the panel becomes an inline accordion — full-width triggers, no
floating card, no shadow — rather than a dropdown positioned off the side of a
375px screen.

## Rolling back

The nav is one block in `unplug-magazine.html` plus `setupMegaMenu()`. Reverting
the commit restores the flat row. Keep the modified-click fix — it was a real
bug on every `[data-page]` link on the site, not something the menu introduced.
