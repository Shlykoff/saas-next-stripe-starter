import { redirect } from "next/navigation";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { LoginForm } from "@/components/auth/login-form";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;

  // Already signed in -- nothing to do here. /onboarding is the single
  // "where do I belong" router: it sends an already-onboarded user straight
  // to /dashboard, or shows the create-organization form otherwise.
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
        <CardTitle className="text-xl">Sign in</CardTitle>
        <CardDescription>Welcome back. Sign in to your account.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {error === "oauth_failed" && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>
              Google sign-in did not complete. Try again, or use email and password below.
            </AlertDescription>
          </Alert>
        )}
        {error === "confirmation_failed" && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>
              This confirmation link is invalid or has expired. Sign up again to get a new one.
            </AlertDescription>
          </Alert>
        )}
        <LoginForm next={next && next.startsWith("/") ? next : "/onboarding"} />
      </CardContent>
    </Card>
  );
}
