-- AlterTable
ALTER TABLE "EmailAccount" ADD COLUMN     "skipDraftRepliesInBulk" BOOLEAN NOT NULL DEFAULT true;
