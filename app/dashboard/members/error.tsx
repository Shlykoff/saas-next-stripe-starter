"use client";

import { useEffect } from "react";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

export default function MembersError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Members page failed to load:", error);
  }, [error]);

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-6 py-16">
      <Alert variant="destructive">
        <AlertTitle>Couldn&apos;t load Members</AlertTitle>
        <AlertDescription>Something went wrong loading the workspace roster. Please try again.</AlertDescription>
      </Alert>
      <Button onClick={reset} className="w-fit">
        Try again
      </Button>
    </main>
  );
}
