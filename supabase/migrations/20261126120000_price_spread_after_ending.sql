-- Price spread, applied AFTER the price ending, so shoes at the same score
-- really get different prices.
--
-- Builds on 20261125120000_price_spread.sql. With the spread taken off before
-- the price ending (as there), most shoes still landed on the same Rs. 100
-- step (e.g. Rs. 4,395 or Rs. 4,495). Now:
--
--   score price = the price ending applied to floor(maximum × score / 100)   (as without a spread)
--   price       = floor(score price × (10000 − offset) / 10000), in whole rupees
--
-- where offset is the product's own 0..price_spread_bp basis points
-- (private.spread_offset_bp, unchanged), e.g. Rs. 4,495 less 2.37% = Rs. 4,388.
-- An offset of 0 (and a spread of 0) keeps the score price exactly. The price
-- is never above the score price, so never above the group maximum.
--
-- Same signature, so every caller (pricing_line, admin_pricing_overview,
-- admin_pricing_products) and the ACL are unchanged. Nothing is repriced here:
-- automatic prices show as out of date until "Review out-of-date automatic
-- prices" is previewed and confirmed. Mirrored by lib/pricing/rules.ts (scorePrice).

create or replace function private.score_calculation(p_max integer, p_score integer, p_giveaway boolean, p_ending integer,
  p_product_id uuid, p_spread_bp integer)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case
    when x.base ->> 'status' = 'ok' and x.o > 0 then
      x.base || jsonb_build_object(
        'price_paisa', (floor((x.base ->> 'price_paisa')::numeric * (10000 - x.o) / 1000000) * 100)::bigint,
        'score_price_paisa', (x.base ->> 'price_paisa')::bigint,
        'spread_bp', x.o)
    else x.base || jsonb_build_object('score_price_paisa', x.base -> 'price_paisa', 'spread_bp', 0)
  end
  from (select private.score_calculation(p_max, p_score, p_giveaway, p_ending) as base,
               private.spread_offset_bp(p_product_id, p_spread_bp) as o) x;
$$;
