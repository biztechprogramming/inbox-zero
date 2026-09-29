import { NextResponse } from "next/server";
import {
  knowledgeBackfillBody,
  runKnowledgeBackfillBatch,
} from "@/utils/knowledge/backfill";
import type { RequestWithLogger } from "@/utils/middleware";
import { withError } from "@/utils/middleware";
import { withQstashOrInternal } from "@/utils/qstash";

export const maxDuration = 300;

async function handleBackfillBatch(request: RequestWithLogger) {
  // A truncated delivery arrives with an empty body; the drain is re-kicked
  // by starting another backfill, so reject rather than crash.
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    request.logger.warn("Ignoring backfill request with unreadable body");
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const body = knowledgeBackfillBody.parse(json);

  const result = await runKnowledgeBackfillBatch({
    ...body,
    logger: request.logger,
  });

  return NextResponse.json(result);
}

export const POST = withError(
  "knowledge/backfill",
  withQstashOrInternal(handleBackfillBatch),
);
