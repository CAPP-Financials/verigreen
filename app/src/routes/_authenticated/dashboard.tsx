import { createFileRoute, redirect } from "@tanstack/react-router";
import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getMe } from "@/lib/me.functions";
import { listDocuments } from "@/lib/documents.functions";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const meQuery = queryOptions({ queryKey: ["me"], queryFn: () => getMe() });
const docsQuery = queryOptions({ queryKey: ["documents"], queryFn: () => listDocuments() });

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({ meta: [{ title: "Dashboard — VeriGreen" }] }),
  beforeLoad: async () => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/login" });
  },
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(meQuery),
      context.queryClient.ensureQueryData(docsQuery),
    ]);
  },
  component: Dashboard,
});

function Dashboard() {
  const me = useSuspenseQuery(meQuery).data;
  const docs = useSuspenseQuery(docsQuery).data.documents;

  const counts = docs.reduce(
    (acc, d) => {
      acc.total++;
      if (d.status === "complete") acc.complete++;
      else if (d.status === "failed") acc.failed++;
      else acc.pending++;
      return acc;
    },
    { total: 0, complete: 0, failed: 0, pending: 0 },
  );

  return (
    <div className="mx-auto max-w-6xl px-8 py-10">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-3xl font-semibold tracking-tight">Dashboard</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {me.org ? me.org.name : "Workspace"} · {me.roles.join(", ") || "no role"}
          </p>
        </div>
        <Badge variant="secondary">Pilot</Badge>
      </div>

      <div className="mt-8 grid gap-4 md:grid-cols-3">
        {[
          { label: "Documents", value: counts.total },
          { label: "Validated", value: counts.complete },
          { label: "In progress / failed", value: counts.pending + counts.failed },
        ].map((m) => (
          <Card key={m.label}>
            <CardHeader>
              <CardDescription>{m.label}</CardDescription>
              <CardTitle className="font-display text-4xl">{m.value}</CardTitle>
            </CardHeader>
          </Card>
        ))}
      </div>

      <Card className="mt-8">
        <CardHeader>
          <CardTitle>Get started</CardTitle>
          <CardDescription>
            Upload a sustainability report PDF. Day-3 ML pipeline will run extraction once Claude wires the outbound dispatch.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Head to <span className="font-medium text-foreground">Documents</span> to upload your first report.
        </CardContent>
      </Card>
    </div>
  );
}
