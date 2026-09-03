-- The profile upgrade fee, as configuration rather than as a constant in a
-- source file.
--
-- §2.3 and §10.10 both require a price the administrator can change WITHOUT a
-- code change. Until now the upgrade fee was `const UPGRADE_FEE = 250.00` in
-- routes/profiles.js, which meant a price change needed a developer and a
-- deploy.
--
-- THIS CHANGES NO PRICE. It is seeded with 250.00, which is exactly what the
-- site charges today — docs/pricing-comparison.md records spec and live in
-- agreement on this one. CLAUDE.md decision 8 forbids a price change without a
-- full spec-vs-live comparison first, and making an existing price editable is
-- not a price change.
--
-- ON CONFLICT DO NOTHING, so a deploy can never overwrite a figure an admin has
-- since set. That is the same guarantee the VAT number has, and for the same
-- reason: a setting that a deploy resets is not a setting.
INSERT INTO settings (key, value) VALUES ('profile_upgrade_fee', '250.00')
ON CONFLICT (key) DO NOTHING;
