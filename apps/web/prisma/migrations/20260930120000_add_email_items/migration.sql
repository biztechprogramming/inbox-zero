-- CreateEnum
CREATE TYPE "EmailItemType" AS ENUM ('COMMITMENT', 'REQUEST', 'DEADLINE', 'DECISION');

-- CreateEnum
CREATE TYPE "EmailItemStatus" AS ENUM ('OPEN', 'RESOLVED');

-- CreateEnum
CREATE TYPE "EmailItemOwner" AS ENUM ('ME', 'THEM');

-- CreateEnum
CREATE TYPE "EmailAudience" AS ENUM ('DIRECT', 'CC', 'LIST');

-- AlterTable
ALTER TABLE "EmailMessage" ADD COLUMN     "knowledgeRequestedAt" TIMESTAMP(3),
ADD COLUMN     "threadSummary" TEXT;

-- CreateTable
CREATE TABLE "EmailItem" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "type" "EmailItemType" NOT NULL,
    "status" "EmailItemStatus" NOT NULL DEFAULT 'OPEN',
    "text" TEXT NOT NULL,
    "owner" "EmailItemOwner",
    "counterpartyEmail" TEXT,
    "counterpartyName" TEXT,
    "dueDate" DATE,
    "threadId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "sourceDate" TIMESTAMP(3) NOT NULL,
    "audience" "EmailAudience" NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "resolvedByMessageId" TEXT,
    "emailAccountId" TEXT NOT NULL,

    CONSTRAINT "EmailItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmailItem_emailAccountId_status_dueDate_idx" ON "EmailItem"("emailAccountId", "status", "dueDate");

-- CreateIndex
CREATE INDEX "EmailItem_emailAccountId_threadId_idx" ON "EmailItem"("emailAccountId", "threadId");

-- CreateIndex
CREATE INDEX "EmailItem_emailAccountId_type_sourceDate_idx" ON "EmailItem"("emailAccountId", "type", "sourceDate");

-- CreateIndex
CREATE INDEX "EmailMessage_emailAccountId_knowledgeExtractedAt_idx" ON "EmailMessage"("emailAccountId", "knowledgeExtractedAt");

-- AddForeignKey
ALTER TABLE "EmailItem" ADD CONSTRAINT "EmailItem_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

