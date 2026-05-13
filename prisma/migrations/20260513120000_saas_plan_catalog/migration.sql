-- SaaS plan catalog: periods, ordering and public visibility.
ALTER TABLE "Plan"
  ADD COLUMN IF NOT EXISTS "billingPeriod" TEXT NOT NULL DEFAULT 'MONTHLY',
  ADD COLUMN IF NOT EXISTS "periodMonths" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "sortOrder" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "isPublic" BOOLEAN NOT NULL DEFAULT true;

UPDATE "Plan"
SET
  "billingPeriod" = CASE
    WHEN "code" = 'FREE' THEN 'FREE'
    WHEN "code" = 'LIFETIME' THEN 'LIFETIME'
    ELSE 'MONTHLY'
  END,
  "periodMonths" = CASE
    WHEN "code" = 'FREE' THEN 0
    WHEN "code" = 'LIFETIME' THEN 0
    ELSE 1
  END,
  "sortOrder" = CASE
    WHEN "code" = 'FREE' THEN 0
    WHEN "code" = 'STARTER' THEN 10
    WHEN "code" = 'PRO' THEN 20
    WHEN "code" = 'BUSINESS' THEN 40
    WHEN "code" = 'LIFETIME' THEN 50
    ELSE "sortOrder"
  END
WHERE "code" IN ('FREE', 'STARTER', 'PRO', 'BUSINESS', 'LIFETIME');
