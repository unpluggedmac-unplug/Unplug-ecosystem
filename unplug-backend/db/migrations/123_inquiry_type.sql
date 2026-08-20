-- WHICH KIND OF ENQUIRY THIS IS.
--
-- Every enquiry arrived through one contact form with a free-text subject, so
-- there was no way to tell a business asking about advertising from a reader
-- asking a question. That distinction now matters: an advertising enquiry
-- starts a five-email advertiser sequence, and sending that to somebody who
-- asked where to find an article would be worse than sending nothing.
--
-- Keyed off a real column rather than searching the subject line for the word
-- "advertising", because a reader who happens to mention advertising in a
-- question would then be enrolled in a sales sequence.
ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS enquiry_type VARCHAR(30) NOT NULL DEFAULT 'general';

ALTER TABLE inquiries DROP CONSTRAINT IF EXISTS inquiries_enquiry_type_check;
ALTER TABLE inquiries ADD CONSTRAINT inquiries_enquiry_type_check
  CHECK (enquiry_type IN ('general', 'advertising'));

CREATE INDEX IF NOT EXISTS idx_inquiries_type ON inquiries (enquiry_type, created_at DESC);
