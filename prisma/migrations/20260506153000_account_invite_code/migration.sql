ALTER TABLE "Account" ADD COLUMN "inviteCode" TEXT;

CREATE UNIQUE INDEX "Account_inviteCode_key" ON "Account"("inviteCode");
