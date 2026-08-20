/**
 * PHASE 10B test support.
 *
 * `User.passwordHash` became NULLABLE in the production-identity-providers
 * work unit, because a Google-only or WhatsApp-only account genuinely has no
 * password (see that column's schema doc comment). Every existing auth spec
 * fixture, however, is an email/password account created through
 * `AuthService.register`, so its hash is always present — and those specs
 * assert against it with `bcrypt.compare`, which takes a `string`.
 *
 * WHY A HELPER RATHER THAN `!` AT EACH CALL SITE. A non-null assertion would
 * silently coerce `null` into the comparison, and `bcrypt.compare(password,
 * null as unknown as string)` does not fail loudly — it would make a test
 * that SHOULD say "this account unexpectedly has no password" instead report
 * the far more confusing "the password did not match". This helper turns
 * that same situation into an explicit, self-describing failure at the exact
 * line it occurred, which is what a test asserting about a password hash
 * actually wants.
 *
 * Test-only. Never imported by production code.
 */
export function requirePasswordHash(
  user: { passwordHash: string | null } | null | undefined,
): string {
  if (!user) {
    throw new Error(
      'requirePasswordHash: expected a user row, received null/undefined.',
    );
  }
  if (user.passwordHash === null) {
    throw new Error(
      'requirePasswordHash: expected this account to have a password hash, but it is NULL. ' +
        'A passwordless account (Google/WhatsApp-only) reached an assertion written for an email/password fixture.',
    );
  }
  return user.passwordHash;
}
