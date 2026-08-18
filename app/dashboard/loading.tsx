import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardHeader, CardContent, CardFooter } from "@/components/ui/card";

// Next.js route-segment loading state: rendered automatically while the
// server component in page.tsx is awaiting its Supabase queries, so a
// navigation to /dashboard never shows a blank white screen.
export default function DashboardLoading() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-16">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-4 w-24" />
      </div>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <Skeleton className="h-5 w-28" />
            <Skeleton className="h-5 w-16 rounded-full" />
          </div>
          <Skeleton className="h-4 w-64" />
        </CardHeader>
        <CardContent />
        <CardFooter>
          <Skeleton className="h-8 w-32" />
        </CardFooter>
      </Card>
    </main>
  );
}
