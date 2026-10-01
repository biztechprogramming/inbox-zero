-- CreateTable
CREATE TABLE "ImapConnection" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "accountId" TEXT NOT NULL,
    "imapHost" TEXT NOT NULL,
    "imapPort" INTEGER NOT NULL,
    "smtpHost" TEXT NOT NULL,
    "smtpPort" INTEGER NOT NULL,
    "username" TEXT NOT NULL,
    "imapPassword" TEXT NOT NULL,
    "smtpPassword" TEXT,

    CONSTRAINT "ImapConnection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ImapConnection_accountId_key" ON "ImapConnection"("accountId");

-- AddForeignKey
ALTER TABLE "ImapConnection" ADD CONSTRAINT "ImapConnection_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
