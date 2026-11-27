/** Provider-reported metadata only; never a credential, entitlement, or budget decision. */
export interface GrantAccount { email?: string; displayName?: string; rateLimitTier?: string; subscriptionStatus?: string; extraUsageEnabled?: boolean }
export interface GrantExtraUsage { enabled?: boolean; usedCredits?: number; monthlyLimit?: number; utilization?: number; currency?: string; spendLimitReached?: boolean }
