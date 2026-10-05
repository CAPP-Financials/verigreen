import { Link, createFileRoute } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, FileSearch, ShieldCheck, BarChart3 } from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "VeriGreen — Validate sustainability claims with cited evidence" },
      {
        name: "description",
        content:
          "Audit-grade validation of corporate sustainability disclosures against GRI and SASB. Cited, scored, and reviewable.",
      },
    ],
  }),
  component: Landing,
});

function Landing() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-10 border-b border-border/60 bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <Link to="/" className="font-display text-lg font-semibold tracking-tight">
            VeriGreen
          </Link>
          <nav className="flex items-center gap-2 text-sm">
            <Link to="/pricing" className="rounded-md px-3 py-2 text-muted-foreground hover:text-foreground">
              Pricing
            </Link>
            <Link to="/login" className="rounded-md px-3 py-2 text-muted-foreground hover:text-foreground">
              Sign in
            </Link>
            <Button asChild size="sm">
              <Link to="/signup">Get started</Link>
            </Button>
          </nav>
        </div>
      </header>

      <section className="mx-auto max-w-4xl px-6 pt-24 pb-20 text-center">
        <Badge variant="secondary" className="mb-6">
          GRI · SASB · audit-ready
        </Badge>
        <h1 className="font-display text-5xl font-semibold tracking-tight md:text-6xl">
          Sustainability claims you can actually defend.
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg text-muted-foreground">
          VeriGreen extracts every quantitative and qualitative sustainability claim from your reports, maps each one to GRI and SASB,
          and returns a substantiation score with page-level citations — ready for assurance review.
        </p>
        <div className="mt-10 flex flex-wrap justify-center gap-3">
          <Button asChild size="lg">
            <Link to="/signup">Start a pilot</Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link to="/pricing">Talk to sales</Link>
          </Button>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 pb-24">
        <div className="grid gap-4 md:grid-cols-3">
          {[
            {
              icon: FileSearch,
              title: "Extract every claim",
              body: "Multi-pass extraction over PDFs returns the raw quote, page, and offset for every sustainability claim.",
            },
            {
              icon: ShieldCheck,
              title: "Substantiation score",
              body: "Each claim is scored against framework requirements with indicator-level evidence — not just a single confidence number.",
            },
            {
              icon: BarChart3,
              title: "Review queue + API",
              body: "Analysts triage low-confidence claims in-app. Engineering teams ship validation into procurement and disclosure workflows.",
            },
          ].map(({ icon: Icon, title, body }) => (
            <Card key={title} className="border-border/60">
              <CardHeader>
                <Icon className="h-6 w-6 text-primary" />
                <CardTitle className="mt-3 text-lg">{title}</CardTitle>
                <CardDescription className="text-sm">{body}</CardDescription>
              </CardHeader>
            </Card>
          ))}
        </div>
      </section>

      <section className="border-t border-border/60 bg-secondary/40">
        <div className="mx-auto max-w-4xl px-6 py-16 text-center">
          <h2 className="font-display text-3xl font-semibold tracking-tight">
            Built for the disclosures decade.
          </h2>
          <p className="mt-3 text-muted-foreground">
            CSRD, SEC climate rule, ISSB — the cost of an unsupported claim is rising. VeriGreen flags it before your auditor does.
          </p>
          <ul className="mt-8 grid gap-3 text-left text-sm md:grid-cols-2">
            {[
              "SOC 2 controls roadmap, data residency on request",
              "Air-gapped option for regulated industries",
              "SAML SSO + scoped API keys + audit log",
              "Per-claim citation for every validation",
            ].map((line) => (
              <li key={line} className="flex items-start gap-2">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <footer className="border-t border-border/60">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-8 text-sm text-muted-foreground">
          <span>© {new Date().getFullYear()} VeriGreen</span>
          <Link to="/pricing" className="hover:text-foreground">Pricing</Link>
        </div>
      </footer>
    </div>
  );
}
