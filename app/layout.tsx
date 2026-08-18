import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { SiteHeader } from "@/components/layout/site-header";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveOrganization, getUserOrganizations } from "@/lib/org";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "SaaS Starter",
  description: "SaaS starter with Supabase Auth, Postgres RLS, and Stripe billing.",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Read-only auth check purely to decide which nav links to show (Sign in
  // vs Dashboard/Sign out) and which organizations to list in the org
  // switcher. This is NOT a security boundary -- it never gates data or
  // actions, only which links/menu items render, so a stale/incorrect read
  // here has no security consequence; the actual protected pages each
  // re-check auth (and, for org-scoped data, RLS) themselves (see proxy.ts's
  // top-of-file comment for why real gating never lives in one shared layer
  // alone).
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  let organizations: Awaited<ReturnType<typeof getUserOrganizations>> = [];
  let activeOrganizationId: string | null = null;

  if (user) {
    // Two RLS-scoped reads (the full list for the menu, the resolved active
    // one for which item is checked/shown) rather than deriving one from the
    // other -- getActiveOrganization also owns the cookie fallback/repair
    // logic (see lib/org.ts), which running here on every request is exactly
    // what keeps the cookie fresh even for a user who never touches the
    // switcher.
    [organizations, activeOrganizationId] = await Promise.all([
      getUserOrganizations(supabase, user.id),
      getActiveOrganization(supabase, user.id).then((org) => org?.id ?? null),
    ]);
  }

  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <SiteHeader
          isSignedIn={Boolean(user)}
          organizations={organizations}
          activeOrganizationId={activeOrganizationId}
        />
        {children}
      </body>
    </html>
  );
}
