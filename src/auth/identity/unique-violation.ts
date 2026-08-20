import { Prisma } from '@prisma/client';

/**
 * PHASE 10B — classification of the `P2002` unique-constraint violations this
 * auth surface can produce, shared by `AuthService.register` and
 * `AuthIdentityService`.
 *
 * ITS OWN MODULE, deliberately: `AuthIdentityService` already depends on
 * `AuthService` (for the session-issuance seam), so putting this helper in
 * either service file and importing it from the other would create a
 * circular import. Both import it from here instead.
 *
 * WHY CLASSIFY AT ALL, rather than checking `error.code === 'P2002'`: these
 * constraints mean genuinely different outcomes — "this email is taken",
 * "this identity belongs to someone else", "you already linked a different
 * account for this provider" — and reporting the wrong one is worse than
 * reporting none. Same discipline as `isSessionUserForeignKeyViolation` in
 * `auth.service.ts`.
 *
 * WHY IT MATCHES ON COLUMN SETS AND NOT CONSTRAINT NAMES.
 *
 * Prisma does not report a uniform shape for `P2002`. Verified EMPIRICALLY
 * against this project's Prisma 6.19.3 + PostgreSQL 16 combination, it
 * reports the violated index as an ARRAY OF COLUMN NAMES:
 *
 *   { modelName: 'AuthIdentity', target: ['provider', 'providerSubject'] }
 *
 * NOT as the database constraint name
 * (`AuthIdentity_provider_providerSubject_key`). An earlier version of this
 * code compared against those constraint names, which meant it matched
 * NOTHING: every concurrent-link and concurrent-sign-in race fell through to
 * its caller's "unexpected error" branch and surfaced as an opaque `500`
 * instead of the clean, specific outcome each race is supposed to produce.
 * That defect was invisible to a test asserting only "at least one call
 * succeeded", which is why the concurrency tests now assert the LOSER's
 * error too.
 *
 * Other Prisma connectors and versions report `meta.constraint` (a string)
 * or a comma-joined `meta.target` string, so all three shapes are accepted
 * and normalized here — a Prisma upgrade that changes the shape must not
 * silently reopen the same hole. `modelName` disambiguates a bare column
 * name (`['email']`) that could in principle belong to another model.
 */
export type UniqueViolation =
  | 'identity_subject'
  | 'identity_user_provider'
  | 'user_email'
  /**
   * `PhoneOtpChallenge.liveKey` — a second LIVE OTP challenge for a phone
   * number that already has one. Not an error condition so much as the
   * database answering an admission question, so its caller maps it to
   * `OTP_RESEND_COOLDOWN` rather than to a failure. See that column's doc
   * comment in `prisma/schema.prisma`.
   */
  | 'otp_live_challenge';

export function classifyUniqueViolation(
  error: unknown,
): UniqueViolation | undefined {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== 'P2002'
  ) {
    return undefined;
  }

  const meta = error.meta as
    { constraint?: unknown; target?: unknown; modelName?: unknown } | undefined;

  const signatures = new Set<string>();
  if (typeof meta?.constraint === 'string') {
    signatures.add(meta.constraint);
  }
  if (typeof meta?.target === 'string') {
    signatures.add(meta.target);
  }
  if (Array.isArray(meta?.target)) {
    signatures.add(meta.target.join(','));
  }

  const modelName = typeof meta?.modelName === 'string' ? meta.modelName : '';

  if (
    signatures.has('AuthIdentity_provider_providerSubject_key') ||
    signatures.has('provider,providerSubject')
  ) {
    return 'identity_subject';
  }
  if (
    signatures.has('AuthIdentity_userId_provider_key') ||
    signatures.has('userId,provider')
  ) {
    return 'identity_user_provider';
  }
  if (
    signatures.has('User_email_key') ||
    (signatures.has('email') && modelName !== 'AuthIdentity')
  ) {
    return 'user_email';
  }
  if (
    signatures.has('PhoneOtpChallenge_liveKey_key') ||
    signatures.has('liveKey')
  ) {
    return 'otp_live_challenge';
  }

  return undefined;
}
