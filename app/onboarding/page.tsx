import { redirect } from "next/navigation";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { CreateOrgForm } from "@/components/onboarding/create-org-form";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveOrganization } from "@/lib/org";

// Real auth gate (defense in depth alongside proxy.ts -- see its
// top-of-file comment for why both layers exist). This is also the single
// place that decides "does this user already belong to an organization" and
// routes accordingly, so /dashboard, /pricing, and /notes don't each need
// their own copy of that decision.
export default async function OnboardingPage() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/onboarding");
  }

  const organization = await getActiveOrganization(supabase, user.id);
  if (organization) {
    redirect("/dashboard");
  }

  return (
    <main className="mx-auto flex max-w-md flex-col gap-8 px-6 py-16">
      <div className="flex flex-col gap-2 text-center">
        <h1 className="text-2xl font-semibold">Create your workspace</h1>
        <p className="text-sm text-muted-foreground">
          You&apos;ll be the owner and can invite teammates later.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Workspace details</CardTitle>
          <CardDescription>This becomes your organization&apos;s name and slug.</CardDescription>
        </CardHeader>
        <CardContent>
          <CreateOrgForm />
        </CardContent>
      </Card>
    </main>
  );
}
