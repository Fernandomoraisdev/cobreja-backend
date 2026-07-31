CREATE TABLE "BackupSnapshot" (
    "id" SERIAL NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'MANUAL',
    "status" TEXT NOT NULL DEFAULT 'COMPLETED',
    "scope" TEXT NOT NULL DEFAULT 'GLOBAL',
    "fileName" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "counts" JSONB NOT NULL DEFAULT '{}',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "accountId" INTEGER,
    "createdByUserId" INTEGER,
    "createdByEmail" TEXT,
    "restoredAt" TIMESTAMP(3),
    "restoredByEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BackupSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BackupSnapshot_scope_kind_createdAt_idx" ON "BackupSnapshot"("scope", "kind", "createdAt");
CREATE INDEX "BackupSnapshot_accountId_createdAt_idx" ON "BackupSnapshot"("accountId", "createdAt");

ALTER TABLE "BackupSnapshot" ADD CONSTRAINT "BackupSnapshot_accountId_fkey"
FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
