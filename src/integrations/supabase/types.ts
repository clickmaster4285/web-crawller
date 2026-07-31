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
    PostgrestVersion: "14.15"
  }
  public: {
    Tables: {
      alert_rules: {
        Row: {
          categories: string[]
          created_at: string
          enabled: boolean
          id: string
          threshold_pct: number
          type: string
          workspace_id: string
        }
        Insert: {
          categories?: string[]
          created_at?: string
          enabled?: boolean
          id?: string
          threshold_pct?: number
          type: string
          workspace_id: string
        }
        Update: {
          categories?: string[]
          created_at?: string
          enabled?: boolean
          id?: string
          threshold_pct?: number
          type?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "alert_rules_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      alerts: {
        Row: {
          competitor_id: string | null
          created_at: string
          detail: string | null
          id: string
          product_id: string | null
          read_at: string | null
          severity: string
          title: string
          type: string
          workspace_id: string
        }
        Insert: {
          competitor_id?: string | null
          created_at?: string
          detail?: string | null
          id?: string
          product_id?: string | null
          read_at?: string | null
          severity?: string
          title: string
          type: string
          workspace_id: string
        }
        Update: {
          competitor_id?: string | null
          created_at?: string
          detail?: string | null
          id?: string
          product_id?: string | null
          read_at?: string | null
          severity?: string
          title?: string
          type?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "alerts_competitor_id_fkey"
            columns: ["competitor_id"]
            isOneToOne: false
            referencedRelation: "competitors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "alerts_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "alerts_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      competitors: {
        Row: {
          country: string | null
          created_at: string
          currency: string
          frequency: string
          id: string
          industry: string | null
          language: string | null
          last_crawl_at: string | null
          name: string
          platform: string | null
          status: string
          website: string
          workspace_id: string
        }
        Insert: {
          country?: string | null
          created_at?: string
          currency?: string
          frequency?: string
          id?: string
          industry?: string | null
          language?: string | null
          last_crawl_at?: string | null
          name: string
          platform?: string | null
          status?: string
          website: string
          workspace_id: string
        }
        Update: {
          country?: string | null
          created_at?: string
          currency?: string
          frequency?: string
          id?: string
          industry?: string | null
          language?: string | null
          last_crawl_at?: string | null
          name?: string
          platform?: string | null
          status?: string
          website?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "competitors_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      crawl_runs: {
        Row: {
          competitor_id: string | null
          error: string | null
          finished_at: string | null
          id: string
          pages_crawled: number
          products_changed: number
          products_found: number
          started_at: string
          status: string
          trigger: string
          workspace_id: string
        }
        Insert: {
          competitor_id?: string | null
          error?: string | null
          finished_at?: string | null
          id?: string
          pages_crawled?: number
          products_changed?: number
          products_found?: number
          started_at?: string
          status?: string
          trigger?: string
          workspace_id: string
        }
        Update: {
          competitor_id?: string | null
          error?: string | null
          finished_at?: string | null
          id?: string
          pages_crawled?: number
          products_changed?: number
          products_found?: number
          started_at?: string
          status?: string
          trigger?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "crawl_runs_competitor_id_fkey"
            columns: ["competitor_id"]
            isOneToOne: false
            referencedRelation: "competitors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "crawl_runs_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      crawl_schedules: {
        Row: {
          cadence: string
          competitor_id: string
          enabled: boolean
          id: string
          last_run_at: string | null
          max_pages: number
          next_run_at: string
          product_only: boolean
          workspace_id: string
        }
        Insert: {
          cadence?: string
          competitor_id: string
          enabled?: boolean
          id?: string
          last_run_at?: string | null
          max_pages?: number
          next_run_at?: string
          product_only?: boolean
          workspace_id: string
        }
        Update: {
          cadence?: string
          competitor_id?: string
          enabled?: boolean
          id?: string
          last_run_at?: string | null
          max_pages?: number
          next_run_at?: string
          product_only?: boolean
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "crawl_schedules_competitor_id_fkey"
            columns: ["competitor_id"]
            isOneToOne: true
            referencedRelation: "competitors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "crawl_schedules_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      price_snapshots: {
        Row: {
          captured_at: string
          id: number
          price: number | null
          product_id: string
          stock: string | null
          workspace_id: string
        }
        Insert: {
          captured_at?: string
          id?: number
          price?: number | null
          product_id: string
          stock?: string | null
          workspace_id: string
        }
        Update: {
          captured_at?: string
          id?: number
          price?: number | null
          product_id?: string
          stock?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "price_snapshots_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "price_snapshots_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      products: {
        Row: {
          brand: string | null
          category: string | null
          competitor_id: string | null
          currency: string
          first_seen_at: string
          gtin: string | null
          id: string
          image_url: string | null
          is_active: boolean
          last_seen_at: string
          match_confidence: number | null
          match_method: string | null
          matched_product_id: string | null
          name: string
          price: number | null
          sku: string | null
          stock: string
          url: string | null
          workspace_id: string
        }
        Insert: {
          brand?: string | null
          category?: string | null
          competitor_id?: string | null
          currency?: string
          first_seen_at?: string
          gtin?: string | null
          id?: string
          image_url?: string | null
          is_active?: boolean
          last_seen_at?: string
          match_confidence?: number | null
          match_method?: string | null
          matched_product_id?: string | null
          name: string
          price?: number | null
          sku?: string | null
          stock?: string
          url?: string | null
          workspace_id: string
        }
        Update: {
          brand?: string | null
          category?: string | null
          competitor_id?: string | null
          currency?: string
          first_seen_at?: string
          gtin?: string | null
          id?: string
          image_url?: string | null
          is_active?: boolean
          last_seen_at?: string
          match_confidence?: number | null
          match_method?: string | null
          matched_product_id?: string | null
          name?: string
          price?: number | null
          sku?: string | null
          stock?: string
          url?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "products_competitor_id_fkey"
            columns: ["competitor_id"]
            isOneToOne: false
            referencedRelation: "competitors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "products_matched_product_id_fkey"
            columns: ["matched_product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "products_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          display_name: string | null
          email: string | null
          id: string
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          email?: string | null
          id: string
        }
        Update: {
          created_at?: string
          display_name?: string | null
          email?: string | null
          id?: string
        }
        Relationships: []
      }
      reports: {
        Row: {
          cadence: string
          categories: string[]
          content: Json
          generated_at: string
          id: string
          name: string
          period: string
          status: string
          workspace_id: string
        }
        Insert: {
          cadence?: string
          categories?: string[]
          content?: Json
          generated_at?: string
          id?: string
          name: string
          period: string
          status?: string
          workspace_id: string
        }
        Update: {
          cadence?: string
          categories?: string[]
          content?: Json
          generated_at?: string
          id?: string
          name?: string
          period?: string
          status?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "reports_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspaces: {
        Row: {
          created_at: string
          currency: string
          id: string
          language: string
          last_scan_at: string | null
          name: string
          owner_id: string
          platform: string | null
          site_url: string | null
          verification_method: string | null
          verified: boolean
        }
        Insert: {
          created_at?: string
          currency?: string
          id?: string
          language?: string
          last_scan_at?: string | null
          name?: string
          owner_id: string
          platform?: string | null
          site_url?: string | null
          verification_method?: string | null
          verified?: boolean
        }
        Update: {
          created_at?: string
          currency?: string
          id?: string
          language?: string
          last_scan_at?: string | null
          name?: string
          owner_id?: string
          platform?: string | null
          site_url?: string | null
          verification_method?: string | null
          verified?: boolean
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      owns_workspace: { Args: { _workspace_id: string }; Returns: boolean }
    }
    Enums: {
      [_ in never]: never
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
    Enums: {},
  },
} as const
