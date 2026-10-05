import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getPrimaryOrgId } from "./auth.server";

export const getMe = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const orgId = await getPrimaryOrgId(supabase, userId);
    if (!orgId) return { userId, org: null, roles: [] as string[] };

    const [{ data: org }, { data: roles }] = await Promise.all([
      supabase.from("organizations").select("id, name, slug").eq("id", orgId).maybeSingle(),
      supabase.from("user_roles").select("role").eq("user_id", userId).eq("org_id", orgId),
    ]);

    return {
      userId,
      org: org ? { id: org.id, name: org.name, slug: org.slug } : null,
      roles: (roles ?? []).map((r) => r.role as string),
    };
  });
