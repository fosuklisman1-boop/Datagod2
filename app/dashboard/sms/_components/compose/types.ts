export interface TenantTemplate { id: string; name: string; body: string; created_at?: string }
export interface ComposeCustomer { phone: string; name: string | null }
export interface ComposeGroup { id: string; name: string; description?: string | null; contact_count: number }
export interface ComposeSender { id: string; sender_id: string; local_status: string; is_pool?: boolean | null; kyc_free?: boolean | null }
