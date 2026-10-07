-- Additive only: no historical Payment or Debt is modified.
CREATE TABLE "PaymentCreationOperation" (
    "id" SERIAL NOT NULL,
    "key" VARCHAR(128) NOT NULL,
    "fingerprint" CHAR(64) NOT NULL,
    "response" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "accountId" INTEGER NOT NULL,
    "debtId" INTEGER NOT NULL,
    CONSTRAINT "PaymentCreationOperation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PaymentCreationOperation_accountId_debtId_key_key"
ON "PaymentCreationOperation"("accountId", "debtId", "key");

ALTER TABLE "PaymentCreationOperation" ADD CONSTRAINT "PaymentCreationOperation_accountId_fkey"
FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PaymentCreationOperation" ADD CONSTRAINT "PaymentCreationOperation_debtId_fkey"
FOREIGN KEY ("debtId") REFERENCES "Debt"("id") ON DELETE CASCADE ON UPDATE CASCADE;
