import { redirect } from "next/navigation";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { SignupForm } from "@/components/auth/signup-form";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) {
    redirect(next && next.startsWith("/") ? next : "/onboarding");
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Create your account</CardTitle>
        <CardDescription>Start your workspace in a couple of minutes.</CardDescription>
      </CardHeader>
      <CardContent>
        <SignupForm next={next && next.startsWith("/") ? next : "/onboarding"} />
      </CardContent>
    </Card>
  );
}
