import { IsString, Length, MinLength } from 'class-validator';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '../auth.constants';

/**
 * Phase 12, work unit 12B-B1: `POST /auth/change-password`.
 *
 * - `currentPassword` uses the SAME deliberately loose validation as
 *   `LoginDto.password` (just "non-empty string") — it is verified against
 *   the stored bcrypt hash in `AuthService.changePassword`, not against the
 *   *current* password-creation policy, for the identical reason
 *   `LoginDto` documents: a legitimately-existing account must never be
 *   rejected here just because the length policy changed after it
 *   registered.
 * - `newPassword` reuses the EXACT policy `RegisterDto.password` already
 *   enforces (`MIN_PASSWORD_LENGTH`..`MAX_PASSWORD_LENGTH`) — the same,
 *   single source of truth, not a second, divergent policy.
 * - `refreshToken` identifies which of the caller's sessions is "the
 *   current one" being rotated (see `AuthService.changePassword`'s doc
 *   comment for why this is required: the access-token payload alone,
 *   `{ sub }`, carries no session identity — matching the existing
 *   `RefreshTokenDto` precedent used by `/auth/refresh` and `/auth/logout`).
 */
export class ChangePasswordDto {
  @IsString()
  @MinLength(1)
  currentPassword!: string;

  @IsString()
  @Length(MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH)
  newPassword!: string;

  @IsString()
  @MinLength(1)
  refreshToken!: string;
}
