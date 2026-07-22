-- Broaden the fallback shout-out names.
--
-- The original seed was entirely Nguni and Sotho-Tswana. Those are the
-- largest language groups, but a magazine that shows only those names every
-- day tells a lot of South Africans the page isn't about them. This adds
-- Tsonga, Venda, Ndebele and Swati, Afrikaans, Cape Malay, Indian South
-- African (Tamil, Telugu, Gujarati and Muslim), English, and the Portuguese,
-- Greek, Jewish and Chinese communities.
--
-- ON CONFLICT DO NOTHING, so re-running is safe and the existing names stay.
INSERT INTO shoutout_fallbacks (name) VALUES
  -- Tsonga
  ('Rirhandzu Mabaso'),
  ('Hlengani Chauke'),
  ('Nkateko Mathebula'),
  -- Venda
  ('Rudzani Mudau'),
  ('Thendo Netshiozwi'),
  ('Mulalo Ramaphosa'),
  -- Ndebele and Swati
  ('Nomsa Mahlangu'),
  ('Sibusiso Dlamini'),
  ('Thandeka Nkambule'),
  -- Afrikaans
  ('Pieter van der Merwe'),
  ('Annelie Botha'),
  ('Johan Pretorius'),
  ('Marietjie du Plessis'),
  -- Cape Malay and Cape Coloured communities
  ('Fatima Abrahams'),
  ('Riedwaan Davids'),
  ('Shireen Isaacs'),
  ('Ashwin Fortuin'),
  -- Indian South African
  ('Priya Naidoo'),
  ('Yusuf Patel'),
  ('Sanjay Pillay'),
  ('Reshma Govender'),
  ('Ayesha Moosa'),
  -- English South African
  ('Sarah Thompson'),
  ('Michael Baker'),
  ('Claire Whitfield'),
  -- Portuguese, Greek, Jewish and Chinese South African communities
  ('Manuel Ferreira'),
  ('Eleni Papadopoulos'),
  ('David Rosenberg'),
  ('Mei Ling Chen')
ON CONFLICT (name) DO NOTHING;
