import { useRef, useState } from "react";
import { Link, createFileRoute, redirect } from "@tanstack/react-router";
import { queryOptions, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import {
  createSignedUpload,
  dispatchExtractionJob,
  finalizeUpload,
  listDocuments,
} from "@/lib/documents.functions";
import { batchDispatch } from "@/lib/batch.functions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Upload, Play, X, CheckCircle2, AlertCircle, Clock } from "lucide-react";

const docsQuery = queryOptions({ queryKey: ["documents"], queryFn: () => listDocuments() });

export const Route = createFileRoute("/_authenticated/documents")({
  head: () => ({ meta: [{ title: "Documents — VeriGreen" }] }),
  beforeLoad: async () => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/login" });
  },
  loader: ({ context }) => context.queryClient.ensureQueryData(docsQuery),
  component: Documents,
});

function statusVariant(status: string) {
  if (status === "complete") return "default" as const;
  if (status === "failed" || status === "cancelled") return "destructive" as const;
  return "secondary" as const;
}

type UploadEntry = {
  id: string;
  file: File;
  status: "uploading" | "uploaded" | "failed";
  documentId?: string;
  error?: string;
};

type BatchResult = {
  dispatched: Array<{ document_id: string; job_id: string }>;
  queued: string[];
  failed: Array<{ document_id: string; error: string }>;
};

function Documents() {
  const docs = useSuspenseQuery(docsQuery).data.documents;
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploads, setUploads] = useState<UploadEntry[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [batchResult, setBatchResult] = useState<BatchResult | null>(null);
  const [busy, setBusy] = useState(false);

  const createSignedUploadFn = useServerFn(createSignedUpload);
  const finalizeUploadFn = useServerFn(finalizeUpload);
  const dispatchFn = useServerFn(dispatchExtractionJob);
  const batchDispatchFn = useServerFn(batchDispatch);

  const refreshDocs = () => queryClient.invalidateQueries({ queryKey: ["documents"] });

  const uploadOne = async (entry: UploadEntry): Promise<UploadEntry> => {
    try {
      const signed = await createSignedUploadFn({
        data: { filename: entry.file.name, byte_size: entry.file.size },
      });
      const { error: upErr } = await supabase.storage
        .from("documents")
        .uploadToSignedUrl(signed.storage_path, signed.token, entry.file);
      if (upErr) throw upErr;
      await finalizeUploadFn({ data: { document_id: signed.document_id } });
      return { ...entry, status: "uploaded", documentId: signed.document_id };
    } catch (err) {
      return {
        ...entry,
        status: "failed",
        error: err instanceof Error ? err.message : "Upload failed",
      };
    }
  };

  const updateEntry = (id: string, patch: Partial<UploadEntry>) => {
    setUploads((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  };

  const handleFiles = async (files: File[]) => {
    const pdfs = files.filter((f) => f.type === "application/pdf" || f.name.endsWith(".pdf"));
    if (pdfs.length === 0) {
      toast.error("Only PDF files are supported");
      return;
    }
    if (pdfs.length > 50) {
      toast.error("Batch limit is 50 files; only the first 50 will be processed");
    }
    const limited = pdfs.slice(0, 50);

    const entries: UploadEntry[] = limited.map((f) => ({
      id: crypto.randomUUID(),
      file: f,
      status: "uploading",
    }));
    setUploads(entries);
    setBatchResult(null);
    setBusy(true);

    // Upload in parallel (max ~5 at a time)
    const concurrency = 5;
    const results: UploadEntry[] = [];
    for (let i = 0; i < entries.length; i += concurrency) {
      const chunk = entries.slice(i, i + concurrency);
      const settled = await Promise.all(
        chunk.map(async (e) => {
          const r = await uploadOne(e);
          updateEntry(e.id, r);
          return r;
        }),
      );
      results.push(...settled);
    }

    const ids = results.filter((r) => r.status === "uploaded" && r.documentId).map((r) => r.documentId!);

    if (ids.length > 0) {
      try {
        const r = await batchDispatchFn({ data: { document_ids: ids } });
        setBatchResult({
          dispatched: r.dispatched.map((d) => ({ document_id: d.document_id, job_id: d.job_id })),
          queued: r.queued,
          failed: r.failed,
        });
        toast.success(`${r.dispatched.length} dispatched, ${r.queued.length} queued`);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Batch dispatch failed");
      }
    }

    refreshDocs();
    setBusy(false);
  };

  const retryQueued = async () => {
    if (!batchResult || batchResult.queued.length === 0) return;
    setBusy(true);
    try {
      const r = await batchDispatchFn({ data: { document_ids: batchResult.queued } });
      setBatchResult({
        dispatched: [...batchResult.dispatched, ...r.dispatched.map((d) => ({ document_id: d.document_id, job_id: d.job_id }))],
        queued: r.queued,
        failed: [...batchResult.failed, ...r.failed],
      });
      toast.success(`${r.dispatched.length} dispatched, ${r.queued.length} still queued`);
      refreshDocs();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Retry failed");
    } finally {
      setBusy(false);
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) handleFiles(files);
  };

  const handleDispatch = async (id: string) => {
    try {
      const r = await dispatchFn({ data: { document_id: id } });
      toast.success(`Job ${r.job_id.slice(0, 8)} queued`);
      refreshDocs();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Dispatch failed");
    }
  };

  return (
    <div className="mx-auto max-w-6xl px-8 py-10">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-semibold tracking-tight">Documents</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Sustainability reports queued for validation.
          </p>
        </div>
      </div>

      {/* Batch upload dropzone */}
      <Card className="mt-8">
        <CardHeader>
          <CardTitle>Upload PDFs</CardTitle>
          <CardDescription>
            Drag and drop up to 50 PDF reports. Files are uploaded, then dispatched in batch
            (5-slot per-org concurrency cap).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            className={`flex flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 py-10 text-center transition-colors ${
              dragOver ? "border-primary bg-primary/5" : "border-border/60 bg-muted/20"
            }`}
          >
            <Upload className="h-8 w-8 text-muted-foreground" />
            <p className="mt-3 text-sm">Drop PDFs here, or</p>
            <input
              ref={fileRef}
              type="file"
              accept="application/pdf"
              multiple
              hidden
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                if (files.length > 0) handleFiles(files);
                if (fileRef.current) fileRef.current.value = "";
              }}
            />
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => fileRef.current?.click()}
              disabled={busy}
            >
              {busy ? "Working…" : "Select files"}
            </Button>
          </div>

          {/* Upload progress list */}
          {uploads.length > 0 && (
            <ul className="mt-4 space-y-1.5 text-sm">
              {uploads.map((u) => (
                <li
                  key={u.id}
                  className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2"
                >
                  <span className="truncate">{u.file.name}</span>
                  {u.status === "uploading" && (
                    <Badge variant="secondary">
                      <Clock className="mr-1 h-3 w-3" /> uploading
                    </Badge>
                  )}
                  {u.status === "uploaded" && (
                    <Badge>
                      <CheckCircle2 className="mr-1 h-3 w-3" /> uploaded
                    </Badge>
                  )}
                  {u.status === "failed" && (
                    <Badge variant="destructive" title={u.error}>
                      <X className="mr-1 h-3 w-3" /> failed
                    </Badge>
                  )}
                </li>
              ))}
            </ul>
          )}

          {/* Batch dispatch summary */}
          {batchResult && (
            <div className="mt-5 grid gap-3 md:grid-cols-3">
              <SummaryCard
                tone="success"
                icon={<CheckCircle2 className="h-4 w-4" />}
                title="Dispatched"
                count={batchResult.dispatched.length}
                items={batchResult.dispatched.map((d) => `${d.document_id.slice(0, 8)} → ${d.job_id.slice(0, 8)}`)}
              />
              <SummaryCard
                tone="warn"
                icon={<Clock className="h-4 w-4" />}
                title="Queued"
                count={batchResult.queued.length}
                items={batchResult.queued.map((id) => id.slice(0, 8))}
                description="Over the 5-slot concurrency cap. Retry later."
                action={
                  batchResult.queued.length > 0 ? (
                    <Button size="sm" variant="outline" onClick={retryQueued} disabled={busy}>
                      Retry queued
                    </Button>
                  ) : undefined
                }
              />
              <SummaryCard
                tone="danger"
                icon={<AlertCircle className="h-4 w-4" />}
                title="Failed"
                count={batchResult.failed.length}
                items={batchResult.failed.map((f) => `${f.document_id.slice(0, 8)}: ${f.error}`)}
              />
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="mt-8">
        <CardHeader>
          <CardTitle>All documents</CardTitle>
          <CardDescription>{docs.length} total</CardDescription>
        </CardHeader>
        <CardContent>
          {docs.length === 0 ? (
            <p className="text-sm text-muted-foreground">No documents yet. Upload a PDF to begin.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Filename</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Size</TableHead>
                  <TableHead>Uploaded</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {docs.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell>
                      <Link to="/documents/$documentId" params={{ documentId: d.id }} className="underline-offset-4 hover:underline">
                        {d.filename}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(d.status)}>{d.status}</Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {(d.byte_size / 1024 / 1024).toFixed(2)} MB
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {new Date(d.created_at).toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button size="sm" variant="outline" onClick={() => handleDispatch(d.id)}>
                        <Play className="mr-1 h-3.5 w-3.5" /> Dispatch
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function SummaryCard({
  tone,
  icon,
  title,
  count,
  items,
  description,
  action,
}: {
  tone: "success" | "warn" | "danger";
  icon: React.ReactNode;
  title: string;
  count: number;
  items: string[];
  description?: string;
  action?: React.ReactNode;
}) {
  const toneClass =
    tone === "success"
      ? "border-primary/40 bg-primary/5"
      : tone === "warn"
        ? "border-amber-500/40 bg-amber-500/5"
        : "border-destructive/40 bg-destructive/5";
  return (
    <div className={`rounded-lg border p-3 ${toneClass}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium">
          {icon}
          {title}
        </div>
        <span className="text-lg font-semibold">{count}</span>
      </div>
      {description && (
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      )}
      {items.length > 0 && (
        <ul className="mt-2 max-h-32 space-y-0.5 overflow-auto font-mono text-xs text-muted-foreground">
          {items.map((it, i) => (
            <li key={i} className="truncate">
              {it}
            </li>
          ))}
        </ul>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
