ALTER TABLE "Subscription"
  ADD COLUMN IF NOT EXISTS "pendingPlanId" INTEGER,
  ADD COLUMN IF NOT EXISTS "pendingChangeAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "Subscription_pendingPlanId_idx" ON "Subscription"("pendingPlanId");
CREATE INDEX IF NOT EXISTS "Subscription_pendingChangeAt_idx" ON "Subscription"("pendingChangeAt");

ALTER TABLE "Subscription"
  ADD CONSTRAINT "Subscription_pendingPlanId_fkey"
  FOREIGN KEY ("pendingPlanId") REFERENCES "Plan"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
