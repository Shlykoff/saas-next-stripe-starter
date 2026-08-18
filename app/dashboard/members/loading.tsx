import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardHeader, CardContent } from "@/components/ui/card";

export default function MembersLoading() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 py-16">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-7 w-28" />
        <Skeleton className="h-4 w-40" />
      </div>
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-20" />
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-32" />
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Skeleton className="h-8 w-full" />
        </CardContent>
      </Card>
    </main>
  );
}
