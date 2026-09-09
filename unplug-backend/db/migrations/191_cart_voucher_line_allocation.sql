-- Phase 12 staging hardening: keep cart voucher/accounting amounts on the
-- service lines they actually belong to.
--
-- The order total was already correct, but routes/orders.js historically
-- spread the final cash total proportionally across every cart item. That
-- makes a service-restricted voucher look like it discounted unrelated
-- services (for example two R300 items with an Event-only R150 voucher were
-- stored as R225 + R225 instead of R300 + R150).
--
-- payments.order_total is the original price of the service line. Maintain:
--   order_total - voucher_discount - credit_used = amount
-- and only put a restricted voucher on matching linked_type rows.

CREATE OR REPLACE FUNCTION reconcile_cart_voucher_lines(p_order_id INTEGER)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  v_code                VARCHAR(40);
  v_order_voucher       NUMERIC(10,2);
  v_order_credit        NUMERIC(10,2);
  v_restriction         VARCHAR(40);
  v_eligible_subtotal   NUMERIC(10,2);
  v_effective_voucher   NUMERIC(10,2);
BEGIN
  SELECT voucher_code,
         COALESCE(voucher_discount, 0),
         COALESCE(credit_used, 0)
    INTO v_code, v_order_voucher, v_order_credit
    FROM orders
   WHERE id = p_order_id;

  IF NOT FOUND OR v_code IS NULL OR v_order_voucher <= 0 THEN
    RETURN;
  END IF;

  SELECT service_restriction
    INTO v_restriction
    FROM vouchers
   WHERE UPPER(code) = UPPER(v_code)
   LIMIT 1;

  -- If the voucher record no longer exists, do not guess how a historic
  -- service-restricted discount should be split.
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT COALESCE(SUM(COALESCE(order_total, amount, 0)), 0)
    INTO v_eligible_subtotal
    FROM payments
   WHERE order_id = p_order_id
     AND (v_restriction IS NULL OR linked_type = v_restriction);

  -- During a cart INSERT the non-eligible line may be inserted first. Wait
  -- until at least one eligible line exists; the next INSERT trigger will
  -- reconcile every line in the order.
  IF v_eligible_subtotal <= 0 THEN
    RETURN;
  END IF;

  -- On a partially-inserted unrestricted cart, never temporarily allocate
  -- more voucher than the lines currently present can absorb. Once all rows
  -- exist this becomes the full authoritative order voucher discount.
  v_effective_voucher := LEAST(v_order_voucher, v_eligible_subtotal);

  WITH base AS (
    SELECT p.id,
           COALESCE(p.order_total, p.amount, 0)::NUMERIC AS original_amount,
           (v_restriction IS NULL OR p.linked_type = v_restriction) AS voucher_eligible
      FROM payments p
     WHERE p.order_id = p_order_id
  ),
  voucher_pre AS (
    SELECT b.*,
           CASE
             WHEN b.voucher_eligible THEN
               ROUND(v_effective_voucher * b.original_amount / NULLIF(v_eligible_subtotal, 0), 2)
             ELSE 0::NUMERIC
           END AS voucher_prelim,
           MAX(b.id) FILTER (WHERE b.voucher_eligible) OVER () AS last_voucher_id
      FROM base b
  ),
  voucher_sum AS (
    SELECT vp.*,
           SUM(vp.voucher_prelim) OVER () AS voucher_prelim_sum
      FROM voucher_pre vp
  ),
  voucher_alloc AS (
    SELECT vs.*,
           CASE
             WHEN vs.voucher_eligible AND vs.id = vs.last_voucher_id THEN
               vs.voucher_prelim + (v_effective_voucher - vs.voucher_prelim_sum)
             ELSE vs.voucher_prelim
           END AS line_voucher
      FROM voucher_sum vs
  ),
  post_voucher AS (
    SELECT va.*,
           GREATEST(0::NUMERIC, va.original_amount - va.line_voucher) AS after_voucher
      FROM voucher_alloc va
  ),
  credit_basis AS (
    SELECT pv.*,
           SUM(pv.after_voucher) OVER () AS total_after_voucher,
           MAX(pv.id) FILTER (WHERE pv.after_voucher > 0) OVER () AS last_credit_id
      FROM post_voucher pv
  ),
  credit_pre AS (
    SELECT cb.*,
           LEAST(v_order_credit, cb.total_after_voucher) AS effective_credit,
           CASE
             WHEN v_order_credit > 0 AND cb.total_after_voucher > 0 THEN
               ROUND(LEAST(v_order_credit, cb.total_after_voucher) * cb.after_voucher / cb.total_after_voucher, 2)
             ELSE 0::NUMERIC
           END AS credit_prelim
      FROM credit_basis cb
  ),
  credit_sum AS (
    SELECT cp.*,
           SUM(cp.credit_prelim) OVER () AS credit_prelim_sum
      FROM credit_pre cp
  ),
  final_alloc AS (
    SELECT cs.*,
           CASE
             WHEN cs.effective_credit > 0 AND cs.id = cs.last_credit_id THEN
               cs.credit_prelim + (cs.effective_credit - cs.credit_prelim_sum)
             ELSE cs.credit_prelim
           END AS line_credit
      FROM credit_sum cs
  )
  UPDATE payments p
     SET voucher_discount = ROUND(fa.line_voucher, 2),
         voucher_code = CASE WHEN fa.line_voucher > 0 THEN v_code ELSE NULL END,
         credit_used = ROUND(fa.line_credit, 2),
         amount = ROUND(GREATEST(0::NUMERIC,
                    fa.original_amount - fa.line_voucher - fa.line_credit), 2)
    FROM final_alloc fa
   WHERE p.id = fa.id;
END;
$$;

CREATE OR REPLACE FUNCTION trg_reconcile_cart_voucher_lines()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.order_id IS NOT NULL THEN
    PERFORM reconcile_cart_voucher_lines(NEW.order_id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_payments_cart_voucher_lines ON payments;
CREATE TRIGGER trg_payments_cart_voucher_lines
AFTER INSERT ON payments
FOR EACH ROW
WHEN (NEW.order_id IS NOT NULL)
EXECUTE FUNCTION trg_reconcile_cart_voucher_lines();

-- Repair cart orders already created before this fix. Safe to run repeatedly:
-- the function derives every value from the authoritative order totals and
-- the original per-line payments.order_total, so a second run is a no-op.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT o.id
      FROM orders o
     WHERE o.voucher_code IS NOT NULL
       AND COALESCE(o.voucher_discount, 0) > 0
       AND EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id)
  LOOP
    PERFORM reconcile_cart_voucher_lines(r.id);
  END LOOP;
END;
$$;
