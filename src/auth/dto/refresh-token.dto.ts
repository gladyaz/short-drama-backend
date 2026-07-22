import { IsString, MinLength } from 'class-validator';

/**
 * Shared by both `POST /auth/refresh` and `POST /auth/logout` — both accept
 * the plaintext refresh token in the request body.
 */
export class RefreshTokenDto {
  @IsString()
  @MinLength(1)
  refreshToken!: string;
}
