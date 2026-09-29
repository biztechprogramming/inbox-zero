-- Marks messages whose durable facts have been written to the Mem0 knowledge
-- store. Null = pending, so failed extractions self-heal on the next sync.
ALTER TABLE "EmailMessage" ADD COLUMN "knowledgeExtractedAt" TIMESTAMP(3);
