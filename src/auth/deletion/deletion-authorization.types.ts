import { AuthProvider } from '../identity/auth-identity.constants';

/**
 * V1 PROVIDER ACCOUNT DELETION — HOW AN ACCOUNT PROVES IT MAY BE DELETED.
 *
 * ======================= THE DEFECT THIS REPLACES =======================
 *
 * `POST /users/me/deletion` used to demand ONE thing — the account's current
 * password — and to fail closed when `User.passwordHash` was `null`. Both of
 * V1's REQUIRED sign-in methods (Google Login, WhatsApp Login) create
 * accounts with no password at all, so the two headline ways into the
 * product were also two ways to own an account that could never be deleted
 * through the product. That is a release blocker, not a rough edge.
 *
 * ===================== THE PRINCIPLE THAT REPLACES IT =====================
 *
 * DELETION PROOF IS APPROPRIATE TO THE IDENTITY, and every accepted proof is
 * a FRESH re-demonstration of the SAME thing the account is signed in with:
 *
 *   `password`  -> re-enter the current password (bcrypt-verified)
 *   `google`    -> present a freshly-obtained Google ID token, verified
 *                  server-side through the EXISTING `GoogleIdentityVerifier`
 *                  port, and bound to THIS account's own Google `sub`
 *   `whatsapp`  -> consume a real one-time code delivered through the
 *                  EXISTING WhatsApp Cloud API path, in a challenge
 *                  namespace (`purpose: 'account_deletion'`) that cannot
 *                  mint a session
 *
 * NOTHING HERE WEAKENS AUTHENTICATION. A valid access token remains
 * necessary and is never sufficient; `confirmDeletion: true` remains
 * necessary and is never a credential. Every method above requires the
 * caller to demonstrate control of the account's real sign-in factor a
 * SECOND time, at deletion time — the property the password-only design had
 * for password accounts, now extended to the accounts that never had one
 * rather than removed from the ones that did.
 *
 * ================= WHY THERE IS NO STORED "DELETION TOKEN" =================
 *
 * A short-lived, single-use authorization ARTIFACT (issued by one endpoint,
 * spent at another, held in Redis) is the usual shape, and it is
 * deliberately NOT what this is. It would only be necessary if a proof could
 * not be verified inside the deletion request itself — and all three can be:
 * a password is compared inline, a Google ID token is verified inline, and
 * an OTP is claimed inline against `PhoneOtpChallenge`, which ALREADY
 * provides exactly the properties such an artifact would have been built to
 * provide (short-lived via `OTP_TTL_MS`, single-use via its `consumedAt`
 * compare-and-set, attempt-bounded, and — because the challenge is looked up
 * by the number this account has linked — bound to this account and
 * unusable for any other).
 *
 * Introducing a second, parallel store to re-express guarantees the database
 * already enforces would add a new persistence system, a new expiry story
 * and a new revocation story, and would put a THIRD credential-shaped value
 * into circulation for no gain. So `DeletionAuthorization` below is a
 * VERIFIED RESULT — the value returned by the one function that decides
 * whether a deletion may proceed — not a bearer token anybody holds.
 */
export type DeletionProofMethod = 'password' | 'google' | 'whatsapp';

/**
 * The closed set, as data, so it can be iterated by the release-gate
 * coverage check and by tests rather than restated in each of them.
 */
export const DELETION_PROOF_METHODS: readonly DeletionProofMethod[] = [
  'password',
  'google',
  'whatsapp',
];

/**
 * The proof method that answers for each `AuthProvider`.
 *
 * A TOTAL MAP, not a lookup that may miss: the release-gate coverage check
 * (`v1-account-deletion-coverage.ts`) walks `AUTH_PROVIDERS` through this
 * map, so adding a fourth sign-in provider without deciding how its accounts
 * delete themselves fails to compile — which is precisely the class of
 * omission that produced the defect this file exists to fix.
 */
export const DELETION_PROOF_METHOD_BY_PROVIDER: Readonly<
  Record<AuthProvider, DeletionProofMethod>
> = {
  email: 'password',
  google: 'google',
  whatsapp: 'whatsapp',
};

/**
 * The result of a SUCCESSFUL proof check — the internal permission slip
 * `AuthService.deleteAccount` requires before it will touch a single row.
 *
 * It is produced only by `DeletionAuthorizationService.authorize`, is never
 * serialized, never leaves the process, and is never accepted from a client.
 * Making it a type (rather than a `boolean` the caller could pass by
 * accident) is what stops a future edit from re-introducing "an
 * authenticated request plus a `true` flag is enough".
 */
export interface DeletionAuthorization {
  /** Which proof the account actually produced. Audited; never a secret. */
  readonly method: DeletionProofMethod;
  /**
   * The account the proof was verified AGAINST — always the id from the
   * caller's own access token. `AuthService.deleteAccount` asserts this
   * equals the account it is about to delete, so a proof can never be
   * carried across accounts by a future refactor.
   */
  readonly userId: string;
  /**
   * For `whatsapp`, the E.164 number whose challenge was consumed, so the
   * post-commit cleanup can purge that number's remaining challenges (see
   * `WhatsAppOtpService.purgeChallengesForPhone`). `null` for every other
   * method.
   */
  readonly whatsappPhoneE164: string | null;
}

/**
 * `GET /users/me/deletion/methods` — what the authenticated caller may use
 * to authorize deleting their OWN account, right now, on THIS server.
 *
 * DELIBERATELY JUST THE METHOD NAMES. A client needs to know which
 * confirmation screen to render; it does not need identity details from this
 * route, and `GET /auth/identities` already returns the safe, masked
 * rendering (email, `+*******7890`) for the screens that display one. Adding
 * a second place that emits identifiers would be a second place to get the
 * masking wrong.
 *
 * AN EMPTY LIST IS A TRUTHFUL, REACHABLE ANSWER, not a bug: a Google-only
 * account on a server with `GOOGLE_AUTH_ENABLED=false` genuinely has no
 * verifiable proof available, and saying so plainly is the whole point of
 * this endpoint. The V1 release gate refuses to certify a release in that
 * posture — see `v1-account-deletion-coverage.ts`.
 */
export interface AccountDeletionMethodsDto {
  methods: DeletionProofMethod[];
}
