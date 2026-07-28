import { IsEmail } from 'class-validator';

/**
 * Phase 12, work unit 12B-B3: `POST /auth/password-reset/request`
 * (DECISIONS.md "Phase 12 ... approved..." entry, decision 3). No password
 * field here — this route only ever generates/returns a reset token for an
 * email, it never accepts a candidate password (that only happens at
 * `POST /auth/password-reset/confirm`).
 */
export class PasswordResetRequestDto {
  @IsEmail()
  email!: string;
}
