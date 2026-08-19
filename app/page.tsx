import Link from "next/link";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center px-6 py-24 text-center">
      <div className="flex max-w-xl flex-col items-center gap-6">
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
          Ship your SaaS, not your billing code
        </h1>
        <p className="text-lg text-muted-foreground">
          Auth, organizations, Stripe subscriptions, and a gated product feature --
          wired together so you can focus on what makes your product different.
        </p>
        <div className="flex flex-col gap-3 sm:flex-row">
          <Button size="lg" nativeButton={false} render={<Link href="/signup" />}>
            Get started
          </Button>
          <Link
            href="/pricing"
            className={cn(buttonVariants({ variant: "outline", size: "lg" }))}
          >
            View pricing
          </Link>
        </div>
      </div>
    </main>
  );
}
