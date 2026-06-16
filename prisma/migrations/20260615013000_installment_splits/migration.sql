CREATE TABLE "InstallmentSplit" (
    "id" SERIAL NOT NULL,
    "splitNumber" INTEGER NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "paidAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "status" "InstallmentStatus" NOT NULL DEFAULT 'PENDING',
    "note" TEXT,
    "installmentId" INTEGER NOT NULL,
    "clientId" INTEGER NOT NULL,
    "accountId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InstallmentSplit_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InstallmentSplit_installmentId_splitNumber_key" ON "InstallmentSplit"("installmentId", "splitNumber");
CREATE INDEX "InstallmentSplit_accountId_status_idx" ON "InstallmentSplit"("accountId", "status");
CREATE INDEX "InstallmentSplit_clientId_dueDate_idx" ON "InstallmentSplit"("clientId", "dueDate");

ALTER TABLE "InstallmentSplit" ADD CONSTRAINT "InstallmentSplit_installmentId_fkey" FOREIGN KEY ("installmentId") REFERENCES "Installment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InstallmentSplit" ADD CONSTRAINT "InstallmentSplit_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InstallmentSplit" ADD CONSTRAINT "InstallmentSplit_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
