/**
 * Response DTOs for the Phase 10 (work unit 10-B4) entitlement endpoint.
 * Deliberately a single boolean with no expired/revoked distinction — see
 * the workspace `DECISIONS.md` "Phase 10 approved..." entry, default
 * decision 4.
 */
export interface EntitlementStatusDto {
  isPremium: boolean;
  expiresAt: string | null;
}

/** Response shape for the dev-only grant/revoke routes (work unit 10-B5). */
export interface DevEntitlementResponseDto {
  userId: string;
  isPremium: boolean;
  expiresAt: string | null;
}
