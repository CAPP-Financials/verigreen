import { useState } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { queryOptions, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { API_KEY_SCOPES, createApiKey, listApiKeys, revokeApiKey } from "@/lib/api-keys.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Copy, Plus } from "lucide-react";

const keysQuery = queryOptions({ queryKey: ["api-keys"], queryFn: () => listApiKeys() });

export const Route = createFileRoute("/_authenticated/api-keys")({
  head: () => ({ meta: [{ title: "API keys — VeriGreen" }] }),
  beforeLoad: async () => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/login" });
  },
  loader: ({ context }) => context.queryClient.ensureQueryData(keysQuery),
  component: ApiKeys,
});

function ApiKeys() {
  const data = useSuspenseQuery(keysQuery).data.keys;
  const qc = useQueryClient();
  const createFn = useServerFn(createApiKey);
  const revokeFn = useServerFn(revokeApiKey);

  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(["documents:read"]);
  const [issued, setIssued] = useState<string | null>(null);

  const toggleScope = (s: string) =>
    setScopes((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));

  const create = async () => {
    if (!name || scopes.length === 0) return toast.error("Name and at least one scope required");
    try {
      const r = await createFn({ data: { name, scopes: scopes as never } });
      setIssued(r.plaintext);
      qc.invalidateQueries({ queryKey: ["api-keys"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    }
  };

  const revoke = async (id: string) => {
    try {
      await revokeFn({ data: { id } });
      qc.invalidateQueries({ queryKey: ["api-keys"] });
      toast.success("Revoked");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    }
  };

  return (
    <div className="mx-auto max-w-6xl px-8 py-10">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="font-display text-3xl font-semibold tracking-tight">API keys</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Scoped credentials for programmatic access. Admins only.
          </p>
        </div>
        <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) { setIssued(null); setName(""); setScopes(["documents:read"]); } }}>
          <DialogTrigger asChild>
            <Button><Plus className="mr-2 h-4 w-4" /> New key</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{issued ? "Save your key" : "Create API key"}</DialogTitle>
              <DialogDescription>
                {issued ? "Copy now — you won't see it again." : "Pick scopes; principle of least privilege."}
              </DialogDescription>
            </DialogHeader>
            {issued ? (
              <div className="space-y-3">
                <code className="block break-all rounded-md bg-muted p-3 font-mono text-xs">{issued}</code>
                <Button
                  className="w-full"
                  variant="outline"
                  onClick={() => { navigator.clipboard.writeText(issued); toast.success("Copied"); }}
                >
                  <Copy className="mr-2 h-4 w-4" /> Copy
                </Button>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="name">Name</Label>
                  <Input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Production ingest" />
                </div>
                <div className="space-y-2">
                  <Label>Scopes</Label>
                  <div className="grid grid-cols-2 gap-2">
                    {API_KEY_SCOPES.map((s) => (
                      <label key={s} className="flex items-center gap-2 rounded-md border border-border/60 px-3 py-2 text-sm">
                        <Checkbox checked={scopes.includes(s)} onCheckedChange={() => toggleScope(s)} />
                        <span className="font-mono text-xs">{s}</span>
                      </label>
                    ))}
                  </div>
                </div>
                <Button onClick={create} className="w-full">Create</Button>
              </div>
            )}
          </DialogContent>
        </Dialog>
      </div>

      <Card className="mt-8">
        <CardHeader>
          <CardTitle>Active keys</CardTitle>
          <CardDescription>{data.length} total</CardDescription>
        </CardHeader>
        <CardContent>
          {data.length === 0 ? (
            <p className="text-sm text-muted-foreground">No keys yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Prefix</TableHead>
                  <TableHead>Scopes</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.map((k) => (
                  <TableRow key={k.id}>
                    <TableCell>{k.name}</TableCell>
                    <TableCell className="font-mono text-xs">{k.prefix}…</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{k.scopes.join(", ")}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{new Date(k.created_at).toLocaleDateString()}</TableCell>
                    <TableCell>
                      {k.revoked_at ? <Badge variant="destructive">revoked</Badge> : <Badge>active</Badge>}
                    </TableCell>
                    <TableCell className="text-right">
                      {!k.revoked_at && (
                        <Button size="sm" variant="ghost" onClick={() => revoke(k.id)}>Revoke</Button>
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
