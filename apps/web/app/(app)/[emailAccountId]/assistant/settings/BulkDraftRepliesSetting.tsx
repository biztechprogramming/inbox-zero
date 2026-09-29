"use client";

import { useCallback } from "react";
import { Toggle } from "@/components/Toggle";
import { updateSkipDraftRepliesInBulkAction } from "@/utils/actions/rule";
import { createSettingActionErrorHandler } from "@/utils/actions/error-handling";
import { SettingCard } from "@/components/SettingCard";
import { useEmailAccountFull } from "@/hooks/useEmailAccountFull";
import { useAction } from "next-safe-action/hooks";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadingContent } from "@/components/LoadingContent";

export function BulkDraftRepliesSetting() {
  const { data, isLoading, error, mutate } = useEmailAccountFull();

  const { execute } = useAction(
    updateSkipDraftRepliesInBulkAction.bind(null, data?.id ?? ""),
    {
      onSuccess: () => {
        mutate();
      },
      onError: createSettingActionErrorHandler({
        mutate,
        prefix: "There was an error",
      }),
    },
  );

  const handleToggle = useCallback(
    (skip: boolean) => {
      if (!data) return;

      mutate({ ...data, skipDraftRepliesInBulk: skip }, false);
      execute({ skip });
    },
    [data, mutate, execute],
  );

  return (
    <SettingCard
      title="Skip drafts when bulk processing"
      description="Don't write draft replies when running your rules on many past emails at once. New emails still get drafts."
      right={
        <LoadingContent
          loading={isLoading}
          error={error}
          loadingComponent={<Skeleton className="h-8 w-32" />}
        >
          <Toggle
            name="skip-draft-replies-in-bulk"
            enabled={data?.skipDraftRepliesInBulk ?? true}
            onChange={handleToggle}
            disabled={isLoading}
          />
        </LoadingContent>
      }
    />
  );
}
