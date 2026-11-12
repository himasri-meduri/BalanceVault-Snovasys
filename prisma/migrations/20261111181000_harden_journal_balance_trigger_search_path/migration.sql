-- Harden verify_balanced_journal_transaction() against temporary-schema
-- relation/operator shadowing while preserving SECURITY INVOKER semantics,
-- exact business logic, exception messages, existing function ownership,
-- existing ACLs, and trigger trg_verify_balanced_journal_transaction.

CREATE OR REPLACE FUNCTION public.verify_balanced_journal_transaction()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
    total_credit BIGINT;
    total_debit BIGINT;
    entry_count INTEGER;
BEGIN
    SELECT
        COALESCE(SUM(CASE WHEN "direction" = 'CREDIT' THEN "amountMinor" ELSE 0 END), 0),
        COALESCE(SUM(CASE WHEN "direction" = 'DEBIT' THEN "amountMinor" ELSE 0 END), 0),
        COUNT(*)
    INTO total_credit, total_debit, entry_count
    FROM public."JournalEntry"
    WHERE "transactionId" = NEW."transactionId";

    IF entry_count < 2 THEN
        RAISE EXCEPTION 'JournalTransaction % must contain at least 2 entries (found %)', NEW."transactionId", entry_count;
    END IF;

    IF total_credit <> total_debit THEN
        RAISE EXCEPTION 'JournalTransaction % is unbalanced: total_credit=% total_debit=%', NEW."transactionId", total_credit, total_debit;
    END IF;

    RETURN NULL;
END;
$$;
