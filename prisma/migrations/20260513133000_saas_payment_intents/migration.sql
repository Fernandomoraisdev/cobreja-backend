CREATE TABLE "SaasPaymentIntent" (
    "id" SERIAL NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'MERCADO_PAGO',
    "status" TEXT NOT NULL DEFAULT 'CREATED',
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'BRL',
    "externalReference" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "mercadoPagoPaymentId" TEXT,
    "qrCode" TEXT,
    "qrCodeBase64" TEXT,
    "ticketUrl" TEXT,
    "rawResponse" JSONB,
    "rawWebhook" JSONB,
    "paidAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3),
    "planId" INTEGER NOT NULL,
    "subscriptionId" INTEGER,
    "accountId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SaasPaymentIntent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SaasPaymentIntent_externalReference_key" ON "SaasPaymentIntent"("externalReference");
CREATE UNIQUE INDEX "SaasPaymentIntent_idempotencyKey_key" ON "SaasPaymentIntent"("idempotencyKey");
CREATE UNIQUE INDEX "SaasPaymentIntent_mercadoPagoPaymentId_key" ON "SaasPaymentIntent"("mercadoPagoPaymentId");
CREATE INDEX "SaasPaymentIntent_accountId_status_idx" ON "SaasPaymentIntent"("accountId", "status");
CREATE INDEX "SaasPaymentIntent_planId_status_idx" ON "SaasPaymentIntent"("planId", "status");
CREATE INDEX "SaasPaymentIntent_subscriptionId_status_idx" ON "SaasPaymentIntent"("subscriptionId", "status");

ALTER TABLE "SaasPaymentIntent" ADD CONSTRAINT "SaasPaymentIntent_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SaasPaymentIntent" ADD CONSTRAINT "SaasPaymentIntent_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SaasPaymentIntent" ADD CONSTRAINT "SaasPaymentIntent_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
