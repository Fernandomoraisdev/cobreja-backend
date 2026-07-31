ALTER TABLE "Payment" ADD COLUMN "deletedAt" TIMESTAMP(3);

CREATE INDEX "Payment_accountId_deletedAt_idx" ON "Payment"("accountId", "deletedAt");
