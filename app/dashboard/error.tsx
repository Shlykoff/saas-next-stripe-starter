"use client";

import { useEffect } from "react";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

// Next.js route-segment error boundary: catches any error thrown while
// rendering/loading app/dashboard/page.tsx (e.g. a Supabase query failing)
// so a broken dashboard never surfaces as a blank page or Next.js's raw
// stack-trace overlay in production.
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Dashboard failed to load:", error);
  }, [error]);

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-6 py-16">
      <Alert variant="destructive">
        <AlertTitle>Couldn&apos;t load your dashboard</AlertTitle>
        <AlertDescription>
          Something went wrong fetching your subscription status. This is usually temporary.
        </AlertDescription>
      </Alert>
      <Button onClick={reset} className="w-fit">
        Try again
      </Button>
    </main>
  );
}
