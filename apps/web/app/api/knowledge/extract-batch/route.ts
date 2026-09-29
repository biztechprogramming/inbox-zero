import { NextResponse } from "next/server";
import { extractKnowledgeFromMessages } from "@/utils/knowledge/extract-from-messages";
import { extractKnowledgeBody } from "@/utils/knowledge/extract-queue";
import type { RequestWithLogger } from "@/utils/middleware";
import { withError } from "@/utils/middleware";
import { withQstashOrInternal } from "@/utils/qstash";

export const maxDuration = 300;

async function handleExtractBatch(request: RequestWithLogger) {
  // A truncated delivery (publisher died mid-request) arrives with an empty
  // body; the messages it carried stay unmarked and re-queue on their next
  // sync, so reject rather than crash.
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    request.logger.warn("Ignoring extract-batch request with unreadable body");
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
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
