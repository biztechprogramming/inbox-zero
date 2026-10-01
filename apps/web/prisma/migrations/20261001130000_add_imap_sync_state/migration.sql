-- CreateTable
CREATE TABLE "ImapFolder" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "emailAccountId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "uidValidity" BIGINT NOT NULL,
    "lastSeenUid" BIGINT NOT NULL DEFAULT 0,
    "specialUse" TEXT,

    CONSTRAINT "ImapFolder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImapMessage" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "emailAccountId" TEXT NOT NULL,
    "messageIdHeader" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "folderPath" TEXT NOT NULL,
    "uid" BIGINT NOT NULL,
    "flags" TEXT[],
    "internalDate" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImapMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ImapFolder_emailAccountId_path_key" ON "ImapFolder"("emailAccountId", "path");

-- CreateIndex
CREATE UNIQUE INDEX "ImapMessage_emailAccountId_messageIdHeader_key" ON "ImapMessage"("emailAccountId", "messageIdHeader");

-- CreateIndex
CREATE INDEX "ImapMessage_emailAccountId_threadId_idx" ON "ImapMessage"("emailAccountId", "threadId");

-- CreateIndex
CREATE INDEX "ImapMessage_emailAccountId_folderPath_uid_idx" ON "ImapMessage"("emailAccountId", "folderPath", "uid");

-- AddForeignKey
ALTER TABLE "ImapFolder" ADD CONSTRAINT "ImapFolder_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImapMessage" ADD CONSTRAINT "ImapMessage_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
