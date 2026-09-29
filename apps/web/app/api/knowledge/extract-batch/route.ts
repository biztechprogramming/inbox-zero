import { NextResponse } from "next/server";
import { extractKnowledgeFromMessages } from "@/utils/knowledge/extract-from-messages";
import { extractKnowledgeBody } from "@/utils/knowledge/extract-queue";
import type { RequestWithLogger } from "@/utils/middleware";
import { withError } from "@/utils/middleware";
import { withQstashOrInternal } from "@/utils/qstash";

export const maxDuration = 300;

async function handleExtractBatch(request: RequestWithLogger) {
  const json = await request.json();
  const { emailAccountId, messageIds } = extractKnowledgeBody.parse(json);

  const result = await extractKnowledgeFromMessages({
    emailAccountId,
    messageIds,
    logger: request.logger,
  });

  return NextResponse.json(result);
}

export const POST = withError(
  "knowledge/extract-batch",
  withQstashOrInternal(handleExtractBatch),
);
