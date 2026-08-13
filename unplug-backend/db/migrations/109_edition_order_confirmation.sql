-- Editions: the order confirmation document, and closing the public-file hole.
--
-- 1. confirmation_url — the proof-of-order PDF generated at checkout, carrying
--    the Reference Code and the payment procedure. Stored in the PRIVATE
--    bucket, not the public one the invoice/receipt PDFs use: this document
--    has the customer's name, email and what they paid on it, so a guessable
--    public link is the wrong place for it.
--
-- 2. download_secured_at — when an admin moved an edition's paid download file
--    into the private bucket.
--
--    The hole it records the closing of: GET /editions/download/:token falls
--    back to editions.pdf_url when no separate download_pdf_url exists, and
--    pdf_url lives in the PUBLIC bucket because it is also the free
--    view-online file. For any edition where the admin never uploaded a
--    separate download copy, the paid file is therefore readable by anyone
--    who has the link — exactly what the brief says must not be possible.
--
--    The fallback is NOT removed here. Removing it would instantly break
--    every already-paid customer whose edition has no private copy yet, which
--    is a worse failure than the one being fixed. Instead the admin screen now
--    says which editions are affected and offers one click to copy the file
--    into the private bucket; once an edition is secured the fallback can
--    never fire for it again.

ALTER TABLE edition_purchases ADD COLUMN IF NOT EXISTS confirmation_url TEXT;
ALTER TABLE editions ADD COLUMN IF NOT EXISTS download_secured_at TIMESTAMPTZ;
