import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  @IsEmail()
  email!: string;

  // Deliberately loose validation here (just "non-empty string, bounded
  // length"): the actual password policy is enforced at registration.
  // Rejecting a login attempt here based on the *current* min-length policy
  // would be harmless today but could reject legitimately-existing accounts
  // if the policy is ever tightened later. Verification happens against the
  // stored bcrypt hash, not against these constraints.
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  password!: string;
}
