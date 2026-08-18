import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { SiteHeader } from "@/components/layout/site-header";
import { createServerSupabaseClient } from "@/lib/supabase/server";

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
  // vs Dashboard/Sign out). This is NOT a security boundary -- it never
  // gates data or actions, only which links render, so a stale/incorrect
  // read here has no security consequence; the actual protected pages each
  // re-check auth themselves (see proxy.ts's top-of-file comment for
  // why real gating never lives in one shared layer alone).
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <SiteHeader isSignedIn={Boolean(user)} />
        {children}
      </body>
    </html>
  );
}
