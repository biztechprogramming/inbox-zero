-- Sender addresses of shared queues (ticket systems, team aliases); mail from
-- them is scoped audience=list in the knowledge store even when the user is
-- addressed directly.
ALTER TABLE "EmailAccount" ADD COLUMN "knowledgeQueueSenders" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
