import { IsString, Length, MinLength } from 'class-validator';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '../auth.constants';

/**
 * Phase 12, work unit 12B-B3: `POST /auth/password-reset/confirm`
 * (DECISIONS.md "Phase 12 ... approved..." entry, decision 3).
 *
 * - `token`: the raw, opaque reset token (never a hash) — verified against
 *   the stored `PasswordResetToken.tokenHash` in `AuthService
 *   .confirmPasswordReset`, not validated for shape/length here beyond
 *   "non-empty string" (mirroring `ChangePasswordDto.refreshToken`'s
 *   identical "just a non-empty string, real verification happens
 *   server-side" precedent).
 * - `newPassword`: reuses the EXACT SAME policy `RegisterDto.password` /
 *   `ChangePasswordDto.newPassword` already enforce — the single source of
 *   truth, not a second, divergent policy.
 */
export class PasswordResetConfirmDto {
  @IsString()
  @MinLength(1)
  token!: string;

  @IsString()
  @Length(MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH)
  newPassword!: string;
}
