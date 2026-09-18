-- AlterTable
ALTER TABLE "EmailMessage" ADD COLUMN     "cc" TEXT,
ADD COLUMN     "hasAttachments" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isReply" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "labels" TEXT[],
ADD COLUMN     "searchVector" tsvector,
ADD COLUMN     "snippet" TEXT,
ADD COLUMN     "subject" TEXT;

-- CreateIndex
CREATE INDEX "EmailMessage_labels_idx" ON "EmailMessage" USING GIN ("labels");

-- CreateIndex
CREATE INDEX "EmailMessage_searchVector_idx" ON "EmailMessage" USING GIN ("searchVector");

-- RenameIndex
ALTER INDEX "ClassificationFeedback_emailAccountId_sender_ruleId_messageId_e" RENAME TO "ClassificationFeedback_emailAccountId_sender_ruleId_message_key";

-- RenameIndex
ALTER INDEX "DraftSendLog_replyMemoryProcessedAt_replyMemoryAttemptCount_cre" RENAME TO "DraftSendLog_replyMemoryProcessedAt_replyMemoryAttemptCount_idx";

-- RenameIndex
ALTER INDEX "ReplyMemory_emailAccountId_kind_scopeType_scopeValue_content_ke" RENAME TO "ReplyMemory_emailAccountId_kind_scopeType_scopeValue_conten_key";

-- RenameIndex
ALTER INDEX "ReplyMemorySource_replyMemoryId_learnedWritingStyleAnalyzedAt_c" RENAME TO "ReplyMemorySource_replyMemoryId_learnedWritingStyleAnalyzed_idx";
