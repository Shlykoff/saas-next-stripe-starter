"use client";

import Link from "next/link";
import { Menu } from "lucide-react";
import { signOut } from "@/app/actions/auth";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

const navLinkClass = cn(buttonVariants({ variant: "ghost" }), "h-10 w-full justify-start px-3 text-sm");

/**
 * Collapses SiteHeader's nav links + sign in/out action into a slide-out
 * Sheet below the `md` breakpoint, where the horizontal nav (logo + org
 * switcher + up to 4 links + an auth button) no longer fits without
 * wrapping/overlapping -- see SiteHeader's matching `hidden md:flex`.
 *
 * Every item is wrapped in SheetClose (not just Link) so tapping it also
 * dismisses the sheet: this client component lives in the root layout and
 * doesn't unmount across client-side navigations, so its own `open` state
 * wouldn't otherwise reset after a link click or a Sign out submit.
 */
export function MobileNav({ isSignedIn }: { isSignedIn: boolean }) {
  return (
    <Sheet>
      <SheetTrigger render={<Button variant="ghost" size="icon" aria-label="Open menu" />}>
        <Menu aria-hidden="true" />
      </SheetTrigger>
      <SheetContent side="right" className="w-72">
        <SheetHeader>
          <SheetTitle>Menu</SheetTitle>
        </SheetHeader>

        <nav className="flex flex-col gap-0.5 px-2" aria-label="Main">
          <SheetClose nativeButton={false} render={<Link href="/pricing" className={navLinkClass} />}>
            Pricing
          </SheetClose>
          {isSignedIn && (
            <>
              <SheetClose nativeButton={false} render={<Link href="/dashboard" className={navLinkClass} />}>
                Dashboard
              </SheetClose>
              <SheetClose nativeButton={false} render={<Link href="/notes" className={navLinkClass} />}>
                Notes
              </SheetClose>
              <SheetClose
                nativeButton={false}
                render={<Link href="/dashboard/members" className={navLinkClass} />}
              >
                Members
              </SheetClose>
            </>
          )}
        </nav>

        <SheetFooter className="border-t">
          {isSignedIn ? (
            <form action={signOut}>
              <SheetClose render={<Button type="submit" variant="outline" className="w-full" />}>
                Sign out
              </SheetClose>
            </form>
          ) : (
            <>
              <SheetClose
                nativeButton={false}
                render={<Link href="/login" className={cn(buttonVariants({ variant: "ghost" }), "w-full")} />}
              >
                Sign in
              </SheetClose>
              <SheetClose
                nativeButton={false}
                render={<Link href="/signup" className={cn(buttonVariants(), "w-full")} />}
              >
                Sign up
              </SheetClose>
            </>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
