import { createFileRoute, redirect, Link } from "@tanstack/react-router";
import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getDocument, listClaims } from "@/lib/documents.functions";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft } from "lucide-react";

export const Route = createFileRoute("/_authenticated/documents/$documentId")({
  head: ({ params }) => ({
    meta: [{ title: `Document ${params.documentId.slice(0, 8)} — VeriGreen` }],
  }),
  beforeLoad: async () => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/login" });
  },
  loader: async ({ context, params }) => {
    const docQ = queryOptions({
      queryKey: ["document", params.documentId],
      queryFn: () => getDocument({ data: { id: params.documentId } }),
    });
    const claimsQ = queryOptions({
      queryKey: ["claims", params.documentId],
      queryFn: () => listClaims({ data: { document_id: params.documentId } }),
    });
    await Promise.all([
      context.queryClient.ensureQueryData(docQ),
      context.queryClient.ensureQueryData(claimsQ),
    ]);
    return { documentId: params.documentId };
  },
  component: DocumentDetail,
});

function DocumentDetail() {
  const { documentId } = Route.useLoaderData();
  const doc = useSuspenseQuery(
    queryOptions({
      queryKey: ["document", documentId],
      queryFn: () => getDocument({ data: { id: documentId } }),
    }),
  ).data.document;
  const claims = useSuspenseQuery(
    queryOptions({
      queryKey: ["claims", documentId],
      queryFn: () => listClaims({ data: { document_id: documentId } }),
    }),
  ).data.claims;

  return (
    <div className="mx-auto max-w-6xl px-8 py-10">
      <Link to="/documents" className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="mr-1 h-4 w-4" /> Back
      </Link>
      <div className="mt-4 flex items-start justify-between">
        <div>
          <h1 className="font-display text-3xl font-semibold tracking-tight">{doc.filename}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Uploaded {new Date(doc.created_at).toLocaleString()} ·{" "}
            {(Number(doc.byte_size) / 1024 / 1024).toFixed(2)} MB
            {doc.page_count ? ` · ${doc.page_count} pages` : ""}
          </p>
        </div>
        <Badge variant="secondary">{doc.status}</Badge>
      </div>

      {doc.failure_reason && (
        <Card className="mt-6 border-destructive/40">
          <CardHeader>
            <CardTitle className="text-base text-destructive">Extraction failed</CardTitle>
            <CardDescription>{doc.failure_reason}</CardDescription>
          </CardHeader>
        </Card>
      )}

      <div className="mt-8 grid gap-6 lg:grid-cols-[1fr,360px]">
        <Card>
          <CardHeader>
            <CardTitle>Claims</CardTitle>
            <CardDescription>{claims.length} extracted</CardDescription>
          </CardHeader>
          <CardContent>
            {claims.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No claims yet — extraction runs once the ML service is wired (Day 3).
              </p>
            ) : (
              <ul className="space-y-3 text-sm">
                {claims.map((c) => (
                  <li key={c.id} className="rounded-md border border-border/60 p-3">
                    <div className="text-xs uppercase tracking-wide text-muted-foreground">
                      Page {c.page_num} · {c.category ?? "uncategorized"}
                    </div>
                    <div className="mt-1">{c.raw_text}</div>
                    {c.normalized_value != null && (
                      <div className="mt-2 text-xs text-muted-foreground">
                        {c.normalized_value} {c.unit ?? ""}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Citation viewer</CardTitle>
            <CardDescription>Page-anchored highlights (Day 3)</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex h-64 items-center justify-center rounded-md border border-dashed border-border text-xs text-muted-foreground">
              PDF preview placeholder
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
