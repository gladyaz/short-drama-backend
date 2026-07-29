import { Equals, IsBoolean, IsString, MinLength } from 'class-validator';

/**
 * Phase 12, work unit 12C-B1: `POST /users/me/deletion` (DECISIONS.md
 * "Phase 12 ... approved..." entry, decision 1: immediate hard account
 * deletion after an explicit irreversible confirmation plus current-password
 * re-authentication).
 *
 * - `currentPassword` uses the SAME deliberately loose validation as
 *   `ChangePasswordDto.currentPassword` (just "non-empty string") — verified
 *   against the stored bcrypt hash in `AuthService.deleteAccount`, not
 *   against the *current* password-creation policy, for the identical
 *   reason `ChangePasswordDto` documents: an account predating the length
 *   policy must never be locked out of deleting itself.
 * - `confirmDeletion` must be the LITERAL boolean `true` — this is decision
 *   1's "explicit irreversible confirmation payload/flag from the client",
 *   enforced here by the global `ValidationPipe` (`whitelist` +
 *   `forbidNonWhitelisted`, plus this field's own `@IsBoolean()` +
 *   `@Equals(true)` pair) BEFORE the request ever reaches
 *   `AccountDeletionController`/`AuthService.deleteAccount` — a request that
 *   omits this field, or sends `false` (or any non-boolean truthy value),
 *   fails cleanly with `400`, never silently proceeding. `@IsBoolean()`
 *   runs first (so a non-boolean value, e.g. the string `"true"`, is
 *   rejected on its own with a clear message) and THEN `@Equals(true)` (so
 *   only the exact boolean `true` — not merely "any truthy value" —
 *   satisfies the confirmation).
 */
export class AccountDeletionDto {
  @IsString()
  @MinLength(1)
  currentPassword!: string;

  @IsBoolean()
  @Equals(true)
  confirmDeletion!: boolean;
}
