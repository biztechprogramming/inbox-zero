-- Semantic search over EmailMessage.embedding
CREATE EXTENSION IF NOT EXISTS vector;

-- AlterTable
ALTER TABLE "EmailMessage" ADD COLUMN     "aiCategory" TEXT,
ADD COLUMN     "aiSummary" TEXT,
ADD COLUMN     "aiUrgency" SMALLINT,
ADD COLUMN     "embedding" vector(1536),
ADD COLUMN     "externalUrl" TEXT;

-- CreateIndex
-- Approximate nearest-neighbour index. `lists` is tuned for tables in the
-- 100k-1M row range; raise it if a mailbox grows well past that.
CREATE INDEX "EmailMessage_embedding_idx" ON "EmailMessage" USING ivfflat ("embedding" vector_cosine_ops) WITH (lists = 100);

-- The search vector now includes the sender display name, so "emails from
-- Stripe" can be answered locally. Rebuild it for rows that already have content.
UPDATE "EmailMessage"
SET "searchVector" = to_tsvector('english', concat_ws(' ', "subject", "snippet", "fromName"))
WHERE "subject" IS NOT NULL;
