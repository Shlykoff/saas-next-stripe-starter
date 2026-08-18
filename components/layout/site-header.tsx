import Link from "next/link";
import { Button } from "@/components/ui/button";
import { signOut } from "@/app/actions/auth";

// Note: this Button is base-ui-based (@base-ui/react/button), which is
// polymorphic via a `render` prop (like Radix's `render`/state-callback
// pattern), NOT the `asChild` prop from Radix UI proper -- passing
// `render={<Link .../>}` makes the Button itself render as that <Link>
// element (with Button's classes/behavior merged on), instead of nesting a
// second interactive element inside a <button>.
export function SiteHeader({ isSignedIn }: { isSignedIn: boolean }) {
  return (
    <header className="border-b">
      <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4 sm:px-6">
        <Link href="/" className="text-sm font-semibold tracking-tight">
          SaaS Starter
        </Link>

        <nav className="flex items-center gap-1 sm:gap-2" aria-label="Main">
          <Button variant="ghost" size="sm" render={<Link href="/pricing" />}>
            Pricing
          </Button>

          {isSignedIn ? (
            <>
              <Button variant="ghost" size="sm" render={<Link href="/dashboard" />}>
                Dashboard
              </Button>
              <Button variant="ghost" size="sm" render={<Link href="/notes" />}>
                Notes
              </Button>
              <form action={signOut}>
                <Button type="submit" variant="outline" size="sm">
                  Sign out
                </Button>
              </form>
            </>
          ) : (
            <>
              <Button variant="ghost" size="sm" render={<Link href="/login" />}>
                Sign in
              </Button>
              <Button size="sm" render={<Link href="/signup" />}>
                Sign up
              </Button>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}
