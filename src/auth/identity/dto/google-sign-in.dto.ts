import { IsString, Length } from 'class-validator';
import { MAX_GOOGLE_ID_TOKEN_LENGTH } from '../auth-identity.constants';

/**
 * PHASE 10B: body of `POST /auth/google` and
 * `POST /auth/identities/google/link`.
 *
 * ONE FIELD, and that is the entire point. The client sends the Google ID
 * TOKEN and nothing else — no email, no `sub`, no name, no "isNewUser"
 * hint. Everything the server acts on is read out of the token AFTER it has
 * been cryptographically verified server-side. A DTO that also accepted an
 * `email` field would be an invitation to trust it.
 *
 * The length bound is enforced here (cheaply, by the global
 * `ValidationPipe`, before the request ever reaches a controller) and AGAIN
 * inside `decodeGoogleIdToken`, which is reachable from unit tests and
 * other callers that never pass through the pipe.
 */
export class GoogleSignInDto {
  @IsString()
  @Length(1, MAX_GOOGLE_ID_TOKEN_LENGTH)
  idToken!: string;
}
