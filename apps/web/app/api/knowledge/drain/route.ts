import { NextResponse } from "next/server";
import { runKnowledgeDrain } from "@/utils/knowledge/drain";
import { knowledgeDrainBody } from "@/utils/knowledge/extract-queue";
import type { RequestWithLogger } from "@/utils/middleware";
import { withError } from "@/utils/middleware";
import { withQstashOrInternal } from "@/utils/qstash";

export const maxDuration = 300;

async function handleDrain(request: RequestWithLogger) {
  // A truncated delivery arrives with an empty body. The work it would have
  // done stays marked pending in Postgres and the next kick picks it up, so
  // reject rather than crash.
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    request.logger.warn(
      "Ignoring knowledge drain request with unreadable body",
    );
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const body = knowledgeDrainBody.parse(json);

  const result = await runKnowledgeDrain({ ...body, logger: request.logger });

  return NextResponse.json(result);
}

export const POST = withError(
  "knowledge/drain",
  withQstashOrInternal(handleDrain),
);
