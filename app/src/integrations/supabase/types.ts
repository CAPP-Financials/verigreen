export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      api_keys: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          key_hash: string
          last_used_at: string | null
          name: string
          org_id: string
          prefix: string
          rate_limit_per_minute: number
          revoked_at: string | null
          scopes: string[]
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          key_hash: string
          last_used_at?: string | null
          name: string
          org_id: string
          prefix: string
          rate_limit_per_minute?: number
          revoked_at?: string | null
          scopes?: string[]
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          key_hash?: string
          last_used_at?: string | null
          name?: string
          org_id?: string
          prefix?: string
          rate_limit_per_minute?: number
          revoked_at?: string | null
          scopes?: string[]
        }
        Relationships: [
          {
            foreignKeyName: "api_keys_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_logs: {
        Row: {
          action: string
          actor_user_id: string | null
          created_at: string
          id: string
          org_id: string
          payload: Json | null
          target_id: string | null
          target_type: string | null
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          created_at?: string
          id?: string
          org_id: string
          payload?: Json | null
          target_id?: string | null
          target_type?: string | null
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          created_at?: string
          id?: string
          org_id?: string
          payload?: Json | null
          target_id?: string | null
          target_type?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_logs_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      claims: {
        Row: {
          category: string | null
          char_end: number
          char_start: number
          created_at: string
          document_id: string
          id: string
          max_value: number | null
          min_value: number | null
          normalized_value: number | null
          normalized_value_uncertain: boolean
          org_id: string
          page_num: number
          raw_text: string
          unit: string | null
        }
        Insert: {
          category?: string | null
          char_end: number
          char_start: number
          created_at?: string
          document_id: string
          id?: string
          max_value?: number | null
          min_value?: number | null
          normalized_value?: number | null
          normalized_value_uncertain?: boolean
          org_id: string
          page_num: number
          raw_text: string
          unit?: string | null
        }
        Update: {
          category?: string | null
          char_end?: number
          char_start?: number
          created_at?: string
          document_id?: string
          id?: string
          max_value?: number | null
          min_value?: number | null
          normalized_value?: number | null
          normalized_value_uncertain?: boolean
          org_id?: string
          page_num?: number
          raw_text?: string
          unit?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "claims_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "claims_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      documents: {
        Row: {
          byte_size: number
          created_at: string
          extraction_job_id: string | null
          failure_reason: string | null
          filename: string
          id: string
          org_id: string
          page_count: number | null
          status: Database["public"]["Enums"]["document_status"]
          status_updated_at: string
          storage_path: string
          taxonomy_version: string | null
          uploaded_by: string | null
        }
        Insert: {
          byte_size?: number
          created_at?: string
          extraction_job_id?: string | null
          failure_reason?: string | null
          filename: string
          id?: string
          org_id: string
          page_count?: number | null
          status?: Database["public"]["Enums"]["document_status"]
          status_updated_at?: string
          storage_path: string
          taxonomy_version?: string | null
          uploaded_by?: string | null
        }
        Update: {
          byte_size?: number
          created_at?: string
          extraction_job_id?: string | null
          failure_reason?: string | null
          filename?: string
          id?: string
          org_id?: string
          page_count?: number | null
          status?: Database["public"]["Enums"]["document_status"]
          status_updated_at?: string
          storage_path?: string
          taxonomy_version?: string | null
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "documents_extraction_job_id_fkey"
            columns: ["extraction_job_id"]
            isOneToOne: false
            referencedRelation: "extraction_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "documents_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      extraction_jobs: {
        Row: {
          completed_at: string | null
          cost_usd: number | null
          created_at: string
          dispatched_at: string | null
          document_id: string
          error_message: string | null
          id: string
          ml_service_response_id: string | null
          org_id: string
          retry_count: number
          status: Database["public"]["Enums"]["extraction_job_status"]
          tokens_in: number | null
          tokens_out: number | null
        }
        Insert: {
          completed_at?: string | null
          cost_usd?: number | null
          created_at?: string
          dispatched_at?: string | null
          document_id: string
          error_message?: string | null
          id?: string
          ml_service_response_id?: string | null
          org_id: string
          retry_count?: number
          status?: Database["public"]["Enums"]["extraction_job_status"]
          tokens_in?: number | null
          tokens_out?: number | null
        }
        Update: {
          completed_at?: string | null
          cost_usd?: number | null
          created_at?: string
          dispatched_at?: string | null
          document_id?: string
          error_message?: string | null
          id?: string
          ml_service_response_id?: string | null
          org_id?: string
          retry_count?: number
          status?: Database["public"]["Enums"]["extraction_job_status"]
          tokens_in?: number | null
          tokens_out?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "extraction_jobs_document_fk"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "extraction_jobs_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      human_corrections: {
        Row: {
          after: Json | null
          before: Json | null
          created_at: string
          id: string
          org_id: string
          reason: string | null
          user_id: string
          validation_id: string
        }
        Insert: {
          after?: Json | null
          before?: Json | null
          created_at?: string
          id?: string
          org_id: string
          reason?: string | null
          user_id: string
          validation_id: string
        }
        Update: {
          after?: Json | null
          before?: Json | null
          created_at?: string
          id?: string
          org_id?: string
          reason?: string | null
          user_id?: string
          validation_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "human_corrections_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "human_corrections_validation_id_fkey"
            columns: ["validation_id"]
            isOneToOne: false
            referencedRelation: "validations"
            referencedColumns: ["id"]
          },
        ]
      }
      model_call_log: {
        Row: {
          created_at: string
          document_id: string | null
          duration_ms: number | null
          id: string
          model_id: string
          org_id: string
          output_hash: string
          system_prompt_hash: string
          tokens_in: number | null
          tokens_out: number | null
          user_message_hash: string
        }
        Insert: {
          created_at?: string
          document_id?: string | null
          duration_ms?: number | null
          id?: string
          model_id: string
          org_id: string
          output_hash: string
          system_prompt_hash: string
          tokens_in?: number | null
          tokens_out?: number | null
          user_message_hash: string
        }
        Update: {
          created_at?: string
          document_id?: string | null
          duration_ms?: number | null
          id?: string
          model_id?: string
          org_id?: string
          output_hash?: string
          system_prompt_hash?: string
          tokens_in?: number | null
          tokens_out?: number | null
          user_message_hash?: string
        }
        Relationships: [
          {
            foreignKeyName: "model_call_log_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "model_call_log_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_members: {
        Row: {
          created_at: string
          org_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          org_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          org_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "organization_members_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          created_at: string
          id: string
          name: string
          slug: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          slug: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          slug?: string
        }
        Relationships: []
      }
      rate_limit_counters: {
        Row: {
          api_key_id: string
          request_count: number
          window_start: string
        }
        Insert: {
          api_key_id: string
          request_count?: number
          window_start: string
        }
        Update: {
          api_key_id?: string
          request_count?: number
          window_start?: string
        }
        Relationships: [
          {
            foreignKeyName: "rate_limit_counters_api_key_id_fkey"
            columns: ["api_key_id"]
            isOneToOne: false
            referencedRelation: "api_keys"
            referencedColumns: ["id"]
          },
        ]
      }
      taxonomy_nodes: {
        Row: {
          code: string
          created_at: string
          description: string | null
          framework: Database["public"]["Enums"]["framework"]
          id: string
          name: string
          parent_id: string | null
          version: string
        }
        Insert: {
          code: string
          created_at?: string
          description?: string | null
          framework: Database["public"]["Enums"]["framework"]
          id?: string
          name: string
          parent_id?: string | null
          version: string
        }
        Update: {
          code?: string
          created_at?: string
          description?: string | null
          framework?: Database["public"]["Enums"]["framework"]
          id?: string
          name?: string
          parent_id?: string | null
          version?: string
        }
        Relationships: [
          {
            foreignKeyName: "taxonomy_nodes_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "taxonomy_nodes"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          org_id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          org_id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          org_id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_roles_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      validations: {
        Row: {
          adversarial_indicators: Json | null
          assigned_to: string | null
          claim_id: string
          confidence: number | null
          created_at: string
          id: string
          model_id: string | null
          org_id: string
          reviewed_at: string | null
          status: string | null
          substantiation_indicators: Json | null
          substantiation_score: number | null
          taxonomy_node_id: string | null
          taxonomy_version: string | null
        }
        Insert: {
          adversarial_indicators?: Json | null
          assigned_to?: string | null
          claim_id: string
          confidence?: number | null
          created_at?: string
          id?: string
          model_id?: string | null
          org_id: string
          reviewed_at?: string | null
          status?: string | null
          substantiation_indicators?: Json | null
          substantiation_score?: number | null
          taxonomy_node_id?: string | null
          taxonomy_version?: string | null
        }
        Update: {
          adversarial_indicators?: Json | null
          assigned_to?: string | null
          claim_id?: string
          confidence?: number | null
          created_at?: string
          id?: string
          model_id?: string | null
          org_id?: string
          reviewed_at?: string | null
          status?: string | null
          substantiation_indicators?: Json | null
          substantiation_score?: number | null
          taxonomy_node_id?: string | null
          taxonomy_version?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "validations_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "validations_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "validations_taxonomy_node_id_fkey"
            columns: ["taxonomy_node_id"]
            isOneToOne: false
            referencedRelation: "taxonomy_nodes"
            referencedColumns: ["id"]
          },
        ]
      }
      webhook_deliveries: {
        Row: {
          attempt_count: number
          created_at: string
          delivered_at: string | null
          endpoint_id: string
          event_type: string
          id: string
          last_attempt_at: string | null
          last_error: string | null
          last_status_code: number | null
          org_id: string
          payload: Json
        }
        Insert: {
          attempt_count?: number
          created_at?: string
          delivered_at?: string | null
          endpoint_id: string
          event_type: string
          id?: string
          last_attempt_at?: string | null
          last_error?: string | null
          last_status_code?: number | null
          org_id: string
          payload: Json
        }
        Update: {
          attempt_count?: number
          created_at?: string
          delivered_at?: string | null
          endpoint_id?: string
          event_type?: string
          id?: string
          last_attempt_at?: string | null
          last_error?: string | null
          last_status_code?: number | null
          org_id?: string
          payload?: Json
        }
        Relationships: [
          {
            foreignKeyName: "webhook_deliveries_endpoint_id_fkey"
            columns: ["endpoint_id"]
            isOneToOne: false
            referencedRelation: "webhook_endpoints"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "webhook_deliveries_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      webhook_endpoints: {
        Row: {
          created_at: string
          enabled: boolean
          events: string[]
          id: string
          org_id: string
          signing_secret: string
          url: string
        }
        Insert: {
          created_at?: string
          enabled?: boolean
          events?: string[]
          id?: string
          org_id: string
          signing_secret: string
          url: string
        }
        Update: {
          created_at?: string
          enabled?: boolean
          events?: string[]
          id?: string
          org_id?: string
          signing_secret?: string
          url?: string
        }
        Relationships: [
          {
            foreignKeyName: "webhook_endpoints_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      webhook_secrets: {
        Row: {
          created_at: string
          id: string
          org_id: string
          revoked_at: string | null
          rotated_at: string | null
          secret_value: string
        }
        Insert: {
          created_at?: string
          id?: string
          org_id: string
          revoked_at?: string | null
          rotated_at?: string | null
          secret_value: string
        }
        Update: {
          created_at?: string
          id?: string
          org_id?: string
          revoked_at?: string | null
          rotated_at?: string | null
          secret_value?: string
        }
        Relationships: [
          {
            foreignKeyName: "webhook_secrets_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      has_any_role: {
        Args: {
          _org_id: string
          _roles: Database["public"]["Enums"]["app_role"][]
          _user_id: string
        }
        Returns: boolean
      }
      has_role: {
        Args: {
          _org_id: string
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      increment_rate_limit: {
        Args: { p_api_key_id: string; p_window_start: string }
        Returns: number
      }
      is_org_member: {
        Args: { _org_id: string; _user_id: string }
        Returns: boolean
      }
    }
    Enums: {
      app_role: "admin" | "analyst" | "viewer"
      document_status:
        | "uploaded"
        | "parsing"
        | "parsed"
        | "extracting"
        | "validating"
        | "complete"
        | "failed"
        | "cancelled"
      extraction_job_status:
        | "pending"
        | "dispatched"
        | "running"
        | "complete"
        | "failed"
        | "cancelled"
      framework: "gri" | "sasb"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "analyst", "viewer"],
      document_status: [
        "uploaded",
        "parsing",
        "parsed",
        "extracting",
        "validating",
        "complete",
        "failed",
        "cancelled",
      ],
      extraction_job_status: [
        "pending",
        "dispatched",
        "running",
        "complete",
        "failed",
        "cancelled",
      ],
      framework: ["gri", "sasb"],
    },
  },
} as const
