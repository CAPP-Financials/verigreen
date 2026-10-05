import { Link, createFileRoute } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Check } from "lucide-react";

export const Route = createFileRoute("/pricing")({
  head: () => ({
    meta: [
      { title: "Pricing — VeriGreen" },
      {
        name: "description",
        content: "Pilot, Team, and Enterprise plans for sustainability claim validation.",
      },
    ],
  }),
  component: Pricing,
});

const tiers = [
  {
    name: "Pilot",
    price: "$0",
    blurb: "Validate one annual report. No credit card.",
    features: ["1 report (≤200 pages)", "GRI mapping", "Citations + export", "Email support"],
    cta: "Start free pilot",
  },
  {
    name: "Team",
    price: "Contact",
    blurb: "Ongoing validation for your reporting function.",
    features: [
      "Unlimited reports",
      "GRI + SASB industry packs",
      "Review queue + roles",
      "API + webhooks",
      "Audit log + SSO",
    ],
    cta: "Talk to sales",
    highlight: true,
  },
  {
    name: "Enterprise",
    price: "Contact",
    blurb: "Procurement-scale validation across thousands of supplier disclosures.",
    features: [
      "Batch ingestion",
      "Custom taxonomy",
      "SAML SSO, SCIM, audit export",
      "VPC / on-prem option",
      "Designated assurance liaison",
    ],
    cta: "Contact sales",
  },
];

function Pricing() {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border/60">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <Link to="/" className="font-display text-lg font-semibold">VeriGreen</Link>
          <nav className="flex items-center gap-2 text-sm">
            <Link to="/login" className="px-3 py-2 text-muted-foreground hover:text-foreground">Sign in</Link>
            <Button asChild size="sm"><Link to="/signup">Get started</Link></Button>
          </nav>
        </div>
      </header>

      <section className="mx-auto max-w-6xl px-6 py-16">
        <div className="text-center">
          <h1 className="font-display text-4xl font-semibold tracking-tight">Pricing</h1>
          <p className="mt-3 text-muted-foreground">
            Every plan ships with cited validations, role-based access, and an audit log.
          </p>
        </div>

        <div className="mt-12 grid gap-6 md:grid-cols-3">
          {tiers.map((t) => (
            <Card key={t.name} className={t.highlight ? "border-primary shadow-sm" : "border-border/60"}>
              <CardHeader>
                <CardTitle className="font-display text-2xl">{t.name}</CardTitle>
                <div className="mt-2 text-3xl font-semibold">{t.price}</div>
                <CardDescription>{t.blurb}</CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2 text-sm">
                  {t.features.map((f) => (
                    <li key={f} className="flex items-start gap-2">
                      <Check className="mt-0.5 h-4 w-4 text-primary" />
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
                <Button asChild className="mt-6 w-full" variant={t.highlight ? "default" : "outline"}>
                  <a href="mailto:sales@verigreen.example">{t.cta}</a>
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>
    </div>
  );
}
