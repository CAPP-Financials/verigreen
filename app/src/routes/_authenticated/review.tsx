import { useMemo, useState } from "react";
import { createFileRoute, redirect, Link } from "@tanstack/react-router";
import { queryOptions, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import {
  listReviewQueue,
  reclassifyValidation,
  resolveReviewItem,
} from "@/lib/review-queue.functions";
import { listTaxonomyNodes } from "@/lib/taxonomy.functions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Check, X, Tag, AlertTriangle } from "lucide-react";

const PAGE_SIZE = 50;

const reviewQueueQuery = (adversarial: boolean, offset: number) =>
  queryOptions({
    queryKey: ["review-queue", { adversarial, offset }],
    queryFn: () => listReviewQueue({ data: { adversarial_only: adversarial, limit: PAGE_SIZE, offset } }),
  });

const taxonomyQuery = queryOptions({
  queryKey: ["taxonomy-nodes"],
  queryFn: () => listTaxonomyNodes(),
});

export const Route = createFileRoute("/_authenticated/review")({
  head: () => ({ meta: [{ title: "Review queue — VeriGreen" }] }),
  beforeLoad: async () => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/login" });
  },
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(reviewQueueQuery(false, 0)),
      context.queryClient.ensureQueryData(taxonomyQuery),
    ]);
  },
  component: Review,
});

type ReviewItem = {
  id: string;
  claim_id: string;
  status: string | null;
  confidence: number | null;
  substantiation_score: number | null;
  adversarial_indicators: unknown;
  assigned_to: string | null;
  reviewed_at: string | null;
  taxonomy_node_id: string | null;
  created_at: string;
  claims: {
    raw_text: string;
    page_num: number;
    category: string | null;
    document_id: string;
  } | null;
};

function Review() {
  const [adversarial, setAdversarial] = useState(false);
  const [offset, setOffset] = useState(0);
  const queryClient = useQueryClient();

  const { data } = useSuspenseQuery(reviewQueueQuery(adversarial, offset));
  const taxonomy = useSuspenseQuery(taxonomyQuery).data.nodes;
  const items = (data.items ?? []) as ReviewItem[];
  const total = data.total ?? 0;

  const resolveFn = useServerFn(resolveReviewItem);
  const reclassifyFn = useServerFn(reclassifyValidation);

  const [rejectTarget, setRejectTarget] = useState<ReviewItem | null>(null);
  const [reclassifyTarget, setReclassifyTarget] = useState<ReviewItem | null>(null);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["review-queue"] });

  const approve = async (item: ReviewItem) => {
    try {
      await resolveFn({ data: { validation_id: item.id, decision: "human_approved" } });
      toast.success("Approved");
      invalidate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    }
  };

  return (
    <div className="mx-auto max-w-7xl px-8 py-10">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-semibold tracking-tight">Review queue</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Low-confidence validations awaiting analyst review.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Switch
            id="adv-only"
            checked={adversarial}
            onCheckedChange={(v) => {
              setOffset(0);
              setAdversarial(v);
            }}
          />
          <Label htmlFor="adv-only" className="text-sm">Adversarial only</Label>
        </div>
      </div>

      <Card className="mt-8">
        <CardHeader>
          <CardTitle>Pending review</CardTitle>
          <CardDescription>
            {total} item{total === 1 ? "" : "s"} · showing {items.length === 0 ? 0 : offset + 1}–
            {offset + items.length}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {items.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              The queue is empty. New low-confidence validations will appear here.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Claim</TableHead>
                  <TableHead>Page</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Confidence</TableHead>
                  <TableHead>Substantiation</TableHead>
                  <TableHead>Flags</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((it) => (
                  <TableRow key={it.id}>
                    <TableCell className="max-w-md">
                      <Link
                        to="/documents/$documentId"
                        params={{ documentId: it.claims?.document_id ?? "" }}
                        className="line-clamp-2 text-sm hover:underline"
                      >
                        {it.claims?.raw_text ?? "—"}
                      </Link>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {it.claims?.page_num ?? "—"}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {it.claims?.category ?? "—"}
                    </TableCell>
                    <TableCell className="text-sm">
                      {it.confidence != null ? `${(Number(it.confidence) * 100).toFixed(0)}%` : "—"}
                    </TableCell>
                    <TableCell className="text-sm">
                      {it.substantiation_score != null
                        ? Number(it.substantiation_score).toFixed(2)
                        : "—"}
                    </TableCell>
                    <TableCell>
                      {it.adversarial_indicators ? (
                        <Badge variant="destructive" className="gap-1">
                          <AlertTriangle className="h-3 w-3" /> adversarial
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="space-x-1 text-right">
                      <Button size="sm" variant="outline" onClick={() => approve(it)}>
                        <Check className="mr-1 h-3.5 w-3.5" /> Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setRejectTarget(it)}
                      >
                        <X className="mr-1 h-3.5 w-3.5" /> Reject
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setReclassifyTarget(it)}
                      >
                        <Tag className="mr-1 h-3.5 w-3.5" /> Reclassify
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          {(total > PAGE_SIZE || offset > 0) && (
            <div className="mt-4 flex items-center justify-between text-sm">
              <Button
                size="sm"
                variant="outline"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              >
                Previous
              </Button>
              <span className="text-muted-foreground">
                Page {Math.floor(offset / PAGE_SIZE) + 1} of{" "}
                {Math.max(1, Math.ceil(total / PAGE_SIZE))}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={offset + items.length >= total}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                Next
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <RejectDialog
        target={rejectTarget}
        onClose={() => setRejectTarget(null)}
        onSubmit={async (reason) => {
          if (!rejectTarget) return;
          try {
            await resolveFn({
              data: {
                validation_id: rejectTarget.id,
                decision: "human_rejected",
                reason: reason || undefined,
              },
            });
            toast.success("Rejected");
            setRejectTarget(null);
            invalidate();
          } catch (e) {
            toast.error(e instanceof Error ? e.message : "Failed");
          }
        }}
      />

      <ReclassifyDialog
        target={reclassifyTarget}
        taxonomy={taxonomy}
        onClose={() => setReclassifyTarget(null)}
        onSubmit={async (nodeId, reason) => {
          if (!reclassifyTarget) return;
          try {
            await reclassifyFn({
              data: {
                validation_id: reclassifyTarget.id,
                new_taxonomy_node_id: nodeId,
                new_status: "human_approved",
                reason: reason || undefined,
              },
            });
            toast.success("Reclassified");
            setReclassifyTarget(null);
            invalidate();
          } catch (e) {
            toast.error(e instanceof Error ? e.message : "Failed");
          }
        }}
      />
    </div>
  );
}

function RejectDialog({
  target,
  onClose,
  onSubmit,
}: {
  target: ReviewItem | null;
  onClose: () => void;
  onSubmit: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(o) => {
        if (!o) {
          setReason("");
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reject validation</DialogTitle>
          <DialogDescription>
            Briefly note why. Stored in human_corrections for calibration.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          placeholder="Reason (optional)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={4}
        />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await onSubmit(reason);
              setReason("");
              setBusy(false);
            }}
          >
            Reject
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReclassifyDialog({
  target,
  taxonomy,
  onClose,
  onSubmit,
}: {
  target: ReviewItem | null;
  taxonomy: Array<{ id: string; framework: string; code: string; name: string }>;
  onClose: () => void;
  onSubmit: (nodeId: string | null, reason: string) => Promise<void>;
}) {
  const [nodeId, setNodeId] = useState<string>("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const grouped = useMemo(() => {
    const map = new Map<string, typeof taxonomy>();
    for (const n of taxonomy) {
      const arr = map.get(n.framework) ?? [];
      arr.push(n);
      map.set(n.framework, arr);
    }
    return Array.from(map.entries());
  }, [taxonomy]);

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(o) => {
        if (!o) {
          setNodeId("");
          setReason("");
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reclassify to a different taxonomy node</DialogTitle>
          <DialogDescription>
            Pick the correct GRI or SASB code. Sets status to human_approved.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="text-xs">Taxonomy node</Label>
            <Select value={nodeId} onValueChange={setNodeId}>
              <SelectTrigger>
                <SelectValue placeholder="Select node…" />
              </SelectTrigger>
              <SelectContent>
                {grouped.map(([framework, nodes]) => (
                  <SelectGroup key={framework}>
                    <SelectLabel className="uppercase">{framework}</SelectLabel>
                    {nodes.map((n) => (
                      <SelectItem key={n.id} value={n.id}>
                        <span className="font-mono text-xs">{n.code}</span> · {n.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Reason (optional)</Label>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            disabled={!nodeId || busy}
            onClick={async () => {
              setBusy(true);
              await onSubmit(nodeId, reason);
              setNodeId("");
              setReason("");
              setBusy(false);
            }}
          >
            Reclassify
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
