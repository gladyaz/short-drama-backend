import { AuthProvider } from './auth-identity.constants';

/**
 * PHASE 10B — `GET /auth/identities`' per-identity response shape.
 *
 * Deliberately shaped like `SessionSummaryDto` (`auth.types.ts`) — the same
 * "just what a 'manage your account' UI needs, and never a secret"
 * discipline, for the same reason: this response is shown to an
 * authenticated caller but also ends up in client logs, crash reports and
 * support screenshots.
 *
 * WHAT IS DELIBERATELY ABSENT: `providerSubject`. A raw Google `sub` is a
 * stable identifier for a real person at another provider, and a raw phone
 * number is directly personal — neither has any use in a UI that is
 * describing which methods are linked. `identifier` carries a SAFE
 * rendering instead: the email for `email`/`google`, and a MASKED phone
 * (`+*******7890`) for `whatsapp`, which is enough for a person to
 * recognize their own number and useless to anyone else.
 *
 * `canBeUnlinked` is computed server-side rather than left for the client
 * to infer, so the "do not remove your last way in" rule has exactly ONE
 * implementation. A client that renders the unlink button off this flag and
 * a server that enforces it in `unlinkIdentity` can never disagree.
 */
export interface AuthIdentitySummaryDto {
  provider: AuthProvider;
  /** Email, masked phone, or `null` when the provider exposes neither safely. */
  identifier: string | null;
  /** Whether this identity can currently be used to sign in at all. */
  usable: boolean;
  /** Whether `DELETE /auth/identities/:provider` would succeed for it right now. */
  canBeUnlinked: boolean;
  createdAt: string;
  verifiedAt: string | null;
}

/**
 * PHASE 10B — `POST /auth/whatsapp/otp/request`'s response.
 *
 * `success` is ALWAYS `true` and the status is ALWAYS `202`, whether or not
 * the number resolves to an existing account — the same frozen
 * anti-enumeration contract `PasswordResetRequestResponseDto` already
 * establishes for `POST /auth/password-reset/request`, and for the same
 * reason. (The one observable exception is the per-number cooldown, which
 * answers `429`; see `AppErrorCode.OTP_RESEND_COOLDOWN` for why that
 * tradeoff is accepted and what it does — and does not — reveal.)
 *
 * `expiresInSeconds` is safe to return: it is a fixed, public constant of
 * the system (`OTP_TTL_MS`), identical for every caller and every number,
 * so it carries no information about the number that was submitted. It
 * exists so a client can render a countdown without hardcoding a value that
 * would silently drift from the server's.
 *
 * `devCode` mirrors `PasswordResetRequestResponseDto.devToken` EXACTLY —
 * the same mechanism, deliberately reused rather than reinvented: present
 * only when `DEV_TOOLS_ENABLED=true` AND `NODE_ENV` is exactly
 * `development` or `test`, and `undefined`/omitted in every other case. It
 * is what lets an e2e suite complete a real OTP round trip over HTTP. It
 * can never appear in production, both because of that gate and because the
 * only provider that can supply a readable code at all
 * (`LocalFakeWhatsAppOtpProvider`) cannot be constructed there.
 */
export interface WhatsAppOtpRequestResponseDto {
  success: true;
  expiresInSeconds: number;
  devCode?: string;
}
