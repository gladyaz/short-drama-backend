import { IsEmail, IsOptional, IsString, Length } from 'class-validator';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '../auth.constants';

export class RegisterDto {
  @IsEmail()
  email!: string;

  @IsString()
  @Length(MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH)
  password!: string;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  displayName?: string;
}
