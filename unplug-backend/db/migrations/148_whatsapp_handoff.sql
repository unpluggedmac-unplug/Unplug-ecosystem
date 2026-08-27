-- "Talk to a person" — the WhatsApp number the assistant hands over to.
--
-- WHY WHATSAPP AND NOT A CHAT WINDOW.
--
-- Real-time chat needs a connection held open, and this instance sleeps when
-- nobody is using it: a WebSocket or an SSE stream dies with it, and the
-- reader is left watching a window that says somebody is there when nobody is.
-- Polling survives the sleep but only moves the problem — an unattended chat
-- box is worse than no chat box, because it promises a person.
--
-- WhatsApp has none of that. It works while the site is asleep, it costs
-- nothing, almost everyone in this audience already has it, and the reply
-- comes from a phone rather than from an admin screen somebody has to be
-- watching. The conversation so far is carried across in the message, so the
-- reader does not have to start again.
--
-- Empty by default. With no number set the assistant offers email instead —
-- an unanswered WhatsApp link is a worse outcome than a plain address, and
-- seeding a real number here would mean guessing at one.

INSERT INTO settings (key, value) VALUES ('whatsapp_number', '')
  ON CONFLICT (key) DO NOTHING;

-- Shown above the button, so somebody messaging at eleven at night is told
-- when to expect an answer rather than left wondering.
INSERT INTO settings (key, value) VALUES ('whatsapp_hours', 'Weekdays, 9am–5pm')
  ON CONFLICT (key) DO NOTHING;
