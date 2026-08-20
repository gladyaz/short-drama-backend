import { IsString, Length } from 'class-validator';
import { OTP_CODE_DIGITS } from '../auth-identity.constants';
import { MAX_RAW_PHONE_INPUT_LENGTH } from '../whatsapp/phone-normalization.util';

/**
 * PHASE 10B: body of `POST /auth/whatsapp/otp/request`.
 *
 * `phone` is validated here ONLY for gross shape (non-empty, bounded
 * length). Real normalization and structural validation happen in
 * `normalizePhoneToE164`, deliberately NOT as a `@Matches()` decorator: the
 * normalizer is the single source of truth for what a phone number means in
 * this system (it is what produces the value stored as
 * `AuthIdentity.providerSubject`), and a regex here would be a second,
 * silently divergent definition of "valid".
 */
export class WhatsAppOtpRequestDto {
  @IsString()
  @Length(1, MAX_RAW_PHONE_INPUT_LENGTH)
  phone!: string;
}

/**
 * PHASE 10B: body of `POST /auth/whatsapp/otp/verify` and
 * `POST /auth/identities/whatsapp/link`.
 *
 * `code` is length-bounded to exactly `OTP_CODE_DIGITS` characters so a
 * caller cannot spend server CPU on an oversized value, but it is NOT
 * pattern-matched to digits here. That is deliberate: a non-numeric code of
 * the right length must consume an ATTEMPT from the challenge's budget just
 * like a numeric wrong guess, and a `ValidationPipe` rejection would let an
 * attacker probe the endpoint for free. The comparison itself is
 * constant-time against the stored keyed hash.
 */
export class WhatsAppOtpVerifyDto {
  @IsString()
  @Length(1, MAX_RAW_PHONE_INPUT_LENGTH)
  phone!: string;

  @IsString()
  @Length(OTP_CODE_DIGITS, OTP_CODE_DIGITS)
  code!: string;
}
