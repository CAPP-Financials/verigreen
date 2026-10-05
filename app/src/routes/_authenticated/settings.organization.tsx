import { useState } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { queryOptions, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { getMe } from "@/lib/me.functions";
import {
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  listWebhookEndpoints,
  listWebhookSecrets,
  rotateWebhookSecret,
} from "@/lib/webhooks.functions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Copy, Plus, RefreshCw, Trash2 } from "lucide-react";

const meQuery = queryOptions({ queryKey: ["me"], queryFn: () => getMe() });
const secretsQuery = queryOptions({ queryKey: ["webhook-secrets"], queryFn: () => listWebhookSecrets() });
const endpointsQuery = queryOptions({ queryKey: ["webhook-endpoints"], queryFn: () => listWebhookEndpoints() });

const EVENT_OPTIONS = ["extraction.completed", "extraction.failed"] as const;

export const Route = createFileRoute("/_authenticated/settings/organization")({
  head: () => ({ meta: [{ title: "Settings — VeriGreen" }] }),
  beforeLoad: async () => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/login" });
  },
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(meQuery),
      context.queryClient.ensureQueryData(secretsQuery),
      context.queryClient.ensureQueryData(endpointsQuery),
    ]);
  },
  component: OrgSettings,
});

function OrgSettings() {
  const me = useSuspenseQuery(meQuery).data;
  const secrets = useSuspenseQuery(secretsQuery).data.secrets;
  const endpoints = useSuspenseQuery(endpointsQuery).data.endpoints;
  const qc = useQueryClient();
  const rotateFn = useServerFn(rotateWebhookSecret);
  const createEndpointFn = useServerFn(createWebhookEndpoint);
  const deleteEndpointFn = useServerFn(deleteWebhookEndpoint);
  const [issued, setIssued] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [newSecret, setNewSecret] = useState<string | null>(null);

  const rotate = async () => {
    try {
      const r = await rotateFn();
      setIssued(r.plaintext);
      qc.invalidateQueries({ queryKey: ["webhook-secrets"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    }
  };

  const disableEndpoint = async (id: string) => {
    try {
      await deleteEndpointFn({ data: { id } });
      toast.success("Endpoint disabled");
      qc.invalidateQueries({ queryKey: ["webhook-endpoints"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    }
  };

  return (
    <div className="mx-auto max-w-4xl px-8 py-10">
      <h1 className="font-display text-3xl font-semibold tracking-tight">Settings</h1>
      <p className="mt-1 text-sm text-muted-foreground">Organization configuration.</p>

      <Card className="mt-8">
        <CardHeader>
          <CardTitle>Organization</CardTitle>
          <CardDescription>Your workspace</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex justify-between"><span className="text-muted-foreground">Name</span><span>{me.org?.name ?? "—"}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Slug</span><span className="font-mono text-xs">{me.org?.slug ?? "—"}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Your roles</span><span className="font-mono text-xs">{me.roles.join(", ") || "—"}</span></div>
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Webhook signing secret</CardTitle>
          <CardDescription>
            VeriGreen signs every callback to your endpoints with this secret using HMAC-SHA256.
            Rotate to revoke the previous one.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {secrets.length === 0 ? (
              <p className="text-sm text-muted-foreground">No secret yet — rotate to generate one.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {secrets.map((s) => (
                  <li key={s.id} className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2">
                    <span className="font-mono text-xs">{s.id.slice(0, 8)}…</span>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">{new Date(s.created_at).toLocaleString()}</span>
                      {s.revoked_at ? <Badge variant="destructive">revoked</Badge> : <Badge>active</Badge>}
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {issued && (
              <div className="space-y-2 rounded-md border border-primary/40 bg-primary/5 p-3">
                <p className="text-xs font-medium">Save this secret — it won't be shown again.</p>
                <code className="block break-all rounded bg-background p-2 font-mono text-xs">{issued}</code>
                <Button size="sm" variant="outline" onClick={() => { navigator.clipboard.writeText(issued); toast.success("Copied"); }}>
                  <Copy className="mr-2 h-3.5 w-3.5" /> Copy
                </Button>
              </div>
            )}

            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline"><RefreshCw className="mr-2 h-4 w-4" /> Rotate secret</Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Rotate webhook secret?</AlertDialogTitle>
                  <AlertDialogDescription>
                    The current secret will be revoked immediately. Any in-flight callbacks signed with it will be rejected.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={rotate}>Rotate</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle>Webhook endpoints</CardTitle>
              <CardDescription>
                VeriGreen posts extraction events to your URLs. Each endpoint has its own signing
                secret, shown once on creation.
              </CardDescription>
            </div>
            <Dialog open={addOpen} onOpenChange={(o) => { setAddOpen(o); if (!o) setNewSecret(null); }}>
              <DialogTrigger asChild>
                <Button size="sm"><Plus className="mr-1 h-4 w-4" /> Add endpoint</Button>
              </DialogTrigger>
              <AddEndpointDialogContent
                onCreate={async (url, events) => {
                  try {
                    const r = await createEndpointFn({ data: { url, events } });
                    setNewSecret(r.signing_secret);
                    qc.invalidateQueries({ queryKey: ["webhook-endpoints"] });
                    toast.success("Endpoint created");
                  } catch (e) {
                    toast.error(e instanceof Error ? e.message : "Failed");
                  }
                }}
                issuedSecret={newSecret}
                onClose={() => { setAddOpen(false); setNewSecret(null); }}
              />
            </Dialog>
          </div>
        </CardHeader>
        <CardContent>
          {endpoints.length === 0 ? (
            <p className="text-sm text-muted-foreground">No endpoints yet. Add one to start receiving events.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>URL</TableHead>
                  <TableHead>Events</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {endpoints.map((ep) => (
                  <TableRow key={ep.id}>
                    <TableCell className="max-w-xs truncate font-mono text-xs">{ep.url}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {(ep.events ?? []).join(", ")}
                    </TableCell>
                    <TableCell>
                      {ep.enabled ? <Badge>enabled</Badge> : <Badge variant="secondary">disabled</Badge>}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(ep.created_at).toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right">
                      {ep.enabled && (
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button size="sm" variant="outline">
                              <Trash2 className="mr-1 h-3.5 w-3.5" /> Disable
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Disable this endpoint?</AlertDialogTitle>
                              <AlertDialogDescription>
                                No further events will be delivered. You can re-add the URL later.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancel</AlertDialogCancel>
                              <AlertDialogAction onClick={() => disableEndpoint(ep.id)}>
                                Disable
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      )}
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

function AddEndpointDialogContent({
  onCreate,
  issuedSecret,
  onClose,
}: {
  onCreate: (url: string, events: Array<"extraction.completed" | "extraction.failed">) => Promise<void>;
  issuedSecret: string | null;
  onClose: () => void;
}) {
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<Array<"extraction.completed" | "extraction.failed">>([
    "extraction.completed",
    "extraction.failed",
  ]);
  const [busy, setBusy] = useState(false);

  const toggle = (e: "extraction.completed" | "extraction.failed", checked: boolean) => {
    setEvents((prev) => (checked ? Array.from(new Set([...prev, e])) : prev.filter((x) => x !== e)));
  };

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Add webhook endpoint</DialogTitle>
        <DialogDescription>
          VeriGreen will POST signed JSON payloads to this URL.
        </DialogDescription>
      </DialogHeader>
      {issuedSecret ? (
        <div className="space-y-2 rounded-md border border-primary/40 bg-primary/5 p-3">
          <p className="text-xs font-medium">Endpoint signing secret — save it now, won't be shown again.</p>
          <code className="block break-all rounded bg-background p-2 font-mono text-xs">{issuedSecret}</code>
          <Button
            size="sm"
            variant="outline"
            onClick={() => { navigator.clipboard.writeText(issuedSecret); toast.success("Copied"); }}
          >
            <Copy className="mr-2 h-3.5 w-3.5" /> Copy
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <div>
            <Label htmlFor="url" className="text-xs">URL</Label>
            <Input
              id="url"
              type="url"
              placeholder="https://your-app.example.com/webhooks/verigreen"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </div>
          <div>
            <Label className="text-xs">Events</Label>
            <div className="mt-1 space-y-2">
              {EVENT_OPTIONS.map((opt) => (
                <label key={opt} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={events.includes(opt)}
                    onCheckedChange={(c) => toggle(opt, c === true)}
                  />
                  <span className="font-mono text-xs">{opt}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
      )}
      <DialogFooter>
        {issuedSecret ? (
          <Button onClick={onClose}>Done</Button>
        ) : (
          <>
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button
              disabled={!url || events.length === 0 || busy}
              onClick={async () => {
                setBusy(true);
                await onCreate(url, events);
                setBusy(false);
              }}
            >
              Create
            </Button>
          </>
        )}
      </DialogFooter>
    </DialogContent>
  );
}
