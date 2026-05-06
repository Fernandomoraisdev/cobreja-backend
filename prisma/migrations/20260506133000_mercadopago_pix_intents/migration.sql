CREATE TABLE "PaymentIntent" (
    "id" SERIAL NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'MERCADO_PAGO',
    "kind" TEXT NOT NULL DEFAULT 'INSTALLMENT_PIX',
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
    "clientId" INTEGER NOT NULL,
    "debtId" INTEGER NOT NULL,
    "installmentId" INTEGER NOT NULL,
    "paymentId" INTEGER,
    "accountId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentIntent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WebhookLog" (
    "id" SERIAL NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'MERCADO_PAGO',
    "eventType" TEXT,
    "eventId" TEXT,
    "resourceId" TEXT,
    "signatureValid" BOOLEAN NOT NULL DEFAULT false,
    "processed" BOOLEAN NOT NULL DEFAULT false,
    "processingError" TEXT,
    "headers" JSONB,
    "payload" JSONB,
    "accountId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookLog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PaymentIntent_externalReference_key" ON "PaymentIntent"("externalReference");
CREATE UNIQUE INDEX "PaymentIntent_idempotencyKey_key" ON "PaymentIntent"("idempotencyKey");
CREATE UNIQUE INDEX "PaymentIntent_mercadoPagoPaymentId_key" ON "PaymentIntent"("mercadoPagoPaymentId");
CREATE INDEX "PaymentIntent_accountId_status_idx" ON "PaymentIntent"("accountId", "status");
CREATE INDEX "PaymentIntent_clientId_status_idx" ON "PaymentIntent"("clientId", "status");
CREATE INDEX "PaymentIntent_installmentId_status_idx" ON "PaymentIntent"("installmentId", "status");
CREATE INDEX "WebhookLog_provider_resourceId_idx" ON "WebhookLog"("provider", "resourceId");
CREATE INDEX "WebhookLog_processed_createdAt_idx" ON "WebhookLog"("processed", "createdAt");

ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_debtId_fkey" FOREIGN KEY ("debtId") REFERENCES "Debt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_installmentId_fkey" FOREIGN KEY ("installmentId") REFERENCES "Installment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WebhookLog" ADD CONSTRAINT "WebhookLog_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
