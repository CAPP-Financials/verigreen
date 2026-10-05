/**
 * Taxonomy helpers — used by the review queue reclassify modal.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const listTaxonomyNodes = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = context;
    const { data, error } = await supabase
      .from("taxonomy_nodes")
      .select("id, framework, code, name, version")
      .order("framework", { ascending: true })
      .order("code", { ascending: true });
    if (error) throw new Error(error.message);
    return { nodes: data ?? [] };
  });
