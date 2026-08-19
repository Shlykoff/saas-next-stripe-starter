import Link from "next/link";
import { Button } from "@/components/ui/button";
import { signOut } from "@/app/actions/auth";
import { OrgSwitcher } from "@/components/layout/org-switcher";
import { MobileNav } from "@/components/layout/mobile-nav";
import type { ActiveOrganization } from "@/lib/org";

// Note: this Button is base-ui-based (@base-ui/react/button), which is
// polymorphic via a `render` prop (like Radix's `render`/state-callback
// pattern), NOT the `asChild` prop from Radix UI proper -- passing
// `render={<Link .../>}` makes the Button itself render as that <Link>
// element (with Button's classes/behavior merged on), instead of nesting a
// second interactive element inside a <button>. Every such usage also
// passes `nativeButton={false}` -- Base UI's Button defaults that prop to
// true (assuming its `render` target will always be a real <button>) and
// logs a dev-mode console error otherwise, since it can no longer assume
// native button semantics (type="button" defaulting, Enter/Space
// activation, form association) apply to whatever `render` produced.
export function SiteHeader({
  isSignedIn,
  organizations,
  activeOrganizationId,
}: {
  isSignedIn: boolean;
  /** Empty when signed out, or when a signed-in user hasn't onboarded yet. */
  organizations: Pick<ActiveOrganization, "id" | "name">[];
  activeOrganizationId: string | null;
}) {
  return (
    <header className="border-b">
      <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-2">
          <Link href="/" className="shrink-0 text-sm font-semibold tracking-tight">
            SaaS Starter
          </Link>
          {isSignedIn && organizations.length > 0 && (
            <>
              <span className="text-muted-foreground/40" aria-hidden="true">
                /
              </span>
              <OrgSwitcher organizations={organizations} activeOrganizationId={activeOrganizationId} />
            </>
          )}
        </div>

        {/*
          Horizontal nav: md (768px) and up only. Below that, this many
          items (up to 4 links + org switcher + an auth button) overlaps
          rather than fitting on one row -- see MobileNav for the
          hamburger/Sheet shown instead at narrower widths.
        */}
        <nav className="hidden items-center gap-1 md:flex md:gap-2" aria-label="Main">
          <Button variant="ghost" size="sm" nativeButton={false} render={<Link href="/pricing" />}>
            Pricing
          </Button>

          {isSignedIn ? (
            <>
              <Button variant="ghost" size="sm" nativeButton={false} render={<Link href="/dashboard" />}>
                Dashboard
              </Button>
              <Button variant="ghost" size="sm" nativeButton={false} render={<Link href="/notes" />}>
                Notes
              </Button>
              <Button variant="ghost" size="sm" nativeButton={false} render={<Link href="/dashboard/members" />}>
                Members
              </Button>
              <form action={signOut}>
                <Button type="submit" variant="outline" size="sm">
                  Sign out
                </Button>
              </form>
            </>
          ) : (
            <>
              <Button variant="ghost" size="sm" nativeButton={false} render={<Link href="/login" />}>
                Sign in
              </Button>
              <Button size="sm" nativeButton={false} render={<Link href="/signup" />}>
                Sign up
              </Button>
            </>
          )}
        </nav>

        {/* Below md: same links + auth action, collapsed into a Sheet. */}
        <div className="md:hidden">
          <MobileNav isSignedIn={isSignedIn} />
        </div>
      </div>
    </header>
  );
}
