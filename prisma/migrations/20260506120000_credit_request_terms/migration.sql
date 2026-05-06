ALTER TABLE "CreditRequest" ADD COLUMN "desiredTermDays" INTEGER;
ALTER TABLE "CreditRequest" ADD COLUMN "requestedInstallments" INTEGER;
ALTER TABLE "CreditRequest" ADD COLUMN "decisionNote" TEXT;
ALTER TABLE "CreditRequest" ADD COLUMN "reviewedAt" TIMESTAMP(3);
ALTER TABLE "CreditRequest" ADD COLUMN "approvedDebtId" INTEGER;
ALTER TABLE "CreditRequest" ADD COLUMN "approvedRenegotiationId" INTEGER;
