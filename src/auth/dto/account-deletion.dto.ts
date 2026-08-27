import {
  Equals,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Length,
  MinLength,
  ValidateIf,
} from 'class-validator';
import {
  MAX_GOOGLE_ID_TOKEN_LENGTH,
  OTP_CODE_DIGITS,
} from '../identity/auth-identity.constants';
import { DELETION_PROOF_METHODS } from '../deletion/deletion-authorization.types';
// `import type` is REQUIRED for a type referenced in a DECORATED property
// signature under `isolatedModules` + `emitDecoratorMetadata` (TS1272): a
// union of string literals has no runtime value for the emitted design-time
// metadata to reference. Same reason `AuthIdentityService` splits its
// `GoogleIdentityVerifier` import from its DI token.
import type { DeletionProofMethod } from '../deletion/deletion-authorization.types';

/**
 * The proof method a request means when it does not say. `password` — which
 * makes the pre-existing body `{ currentPassword, confirmDeletion: true }`
 * continue to validate and behave EXACTLY as it always did, with no `method`
 * field and no client change. That backward compatibility is deliberate:
 * this work unit fixes an omission for passwordless accounts, and a fix that
 * simultaneously broke every password account's existing request would not
 * be an improvement.
 */
export const DEFAULT_DELETION_PROOF_METHOD: DeletionProofMethod = 'password';

/**
 * The single definition of "which proof does this request name", used BOTH
 * by the conditional validators below and by
 * `DeletionAuthorizationService.authorize`. One function rather than two
 * copies of `dto.method ?? 'password'`, because a drift between what the
 * `ValidationPipe` required and what the service then verified would mean a
 * request validated against one proof and checked against another.
 */
export function resolveDeletionProofMethod(dto: {
  method?: DeletionProofMethod;
}): DeletionProofMethod {
  return dto.method ?? DEFAULT_DELETION_PROOF_METHOD;
}

/**
 * V1 PROVIDER ACCOUNT DELETION — body of `POST /users/me/deletion`.
 *
 * ONE ENDPOINT, ONE DISCRIMINATED PROOF, rather than three per-provider
 * deletion routes. The action, the confirmation semantics, the rate limit,
 * the role rule, the transaction and the audit trail are identical for all
 * three methods; only the evidence differs. Three routes would have been
 * three copies of everything else, kept in agreement by convention — and the
 * defect this work unit fixes is precisely what happens when one
 * authentication path is handled and another is quietly not.
 *
 * `method` SELECTS WHICH FIELD IS REQUIRED, via `@ValidateIf`. The
 * irrelevant proof fields are neither required nor rejected by the global
 * `ValidationPipe` (`whitelist` + `forbidNonWhitelisted` keeps them, because
 * they carry validation metadata, and skips their validators) — a stray
 * `currentPassword` sent alongside `method: "google"` is simply ignored,
 * never used as proof: `DeletionAuthorizationService` reads only the field
 * belonging to `method`, so no request can downgrade its own proof by
 * including a weaker one.
 *
 * `confirmDeletion` IS NOT, AND NEVER WAS, AUTHENTICATION. It is the
 * explicit irreversible-intent flag (DECISIONS.md decision 1) and it is
 * required in ADDITION to a real proof, never instead of one. It remains the
 * literal boolean `true` — `@IsBoolean()` runs first so the string `"true"`
 * is rejected with a clear message, then `@Equals(true)` so only the exact
 * boolean satisfies it.
 */
export class AccountDeletionDto {
  /**
   * Which proof this request carries. OPTIONAL, defaulting to `password` —
   * see `DEFAULT_DELETION_PROOF_METHOD`. An unrecognized value is rejected
   * by the pipe as a clean `400` before any account is loaded, so a typo can
   * never be silently treated as some other method.
   */
  @IsOptional()
  @IsIn(DELETION_PROOF_METHODS)
  method?: DeletionProofMethod;

  /**
   * `method: "password"`. The SAME deliberately loose validation
   * `ChangePasswordDto.currentPassword` uses (just "non-empty string"), for
   * the identical reason it documents: this value is verified against the
   * stored bcrypt hash, never against the CURRENT password-creation policy,
   * so an account predating a policy change is never locked out of deleting
   * itself.
   */
  @ValidateIf(
    (dto: AccountDeletionDto) => resolveDeletionProofMethod(dto) === 'password',
  )
  @IsString()
  @MinLength(1)
  currentPassword?: string;

  /**
   * `method: "google"`. A freshly obtained Google ID token — the same single
   * opaque field `GoogleSignInDto` accepts, bounded the same way and for the
   * same reason: everything the server acts on is read out of the token
   * AFTER server-side verification, so the DTO deliberately has nowhere to
   * put a client-claimed email, `sub` or display name.
   */
  @ValidateIf(
    (dto: AccountDeletionDto) => resolveDeletionProofMethod(dto) === 'google',
  )
  @IsString()
  @Length(1, MAX_GOOGLE_ID_TOKEN_LENGTH)
  idToken?: string;

  /**
   * `method: "whatsapp"`. The code delivered by
   * `POST /users/me/deletion/whatsapp/otp`.
   *
   * NO `phone` FIELD, unlike `WhatsAppOtpVerifyDto` — and that absence is a
   * security property, not an omission. The number is read from the
   * authenticated account's own linked `AuthIdentity`, so a caller cannot
   * point a deletion confirmation at a number they merely happen to control.
   *
   * Length-bounded to exactly `OTP_CODE_DIGITS` but deliberately NOT
   * digit-matched, exactly as `WhatsAppOtpVerifyDto.code` documents: a
   * non-numeric guess of the right length must spend an attempt from the
   * challenge's budget rather than being refused for free by the pipe.
   */
  @ValidateIf(
    (dto: AccountDeletionDto) => resolveDeletionProofMethod(dto) === 'whatsapp',
  )
  @IsString()
  @Length(OTP_CODE_DIGITS, OTP_CODE_DIGITS)
  code?: string;

  @IsBoolean()
  @Equals(true)
  confirmDeletion!: boolean;
}
