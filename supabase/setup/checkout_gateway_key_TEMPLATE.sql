-- Registers the website's checkout gateway secret (README, "Checkout: setup").
-- TEMPLATE: replace the placeholders; never paste the secret itself here.
--
-- 1. On your computer: node scripts/checkout-gateway-key.mjs
--    It writes the secret to .env.local and prints the line below with the
--    real hash filled in.
-- 2. Run that line in the SQL Editor:

insert into private.checkout_gateway_keys (key_hash, label)
values (decode('<64 hex characters printed by the script>', 'hex'), 'website <date>');

-- Rotation (no downtime): register the new hash as above, deploy the new
-- secret to the website, check an order lookup works, then retire the old one:
--   update private.checkout_gateway_keys set retired_at = now()
--   where label = '<old label>' and retired_at is null;
--
-- Which keys are active:
--   select label, created_at, retired_at from private.checkout_gateway_keys order by created_at;
