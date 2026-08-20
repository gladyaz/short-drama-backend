import { HttpStatus } from '@nestjs/common';
import { AppErrorCode } from '../../../common/errors/app-error-code';
import { AppException } from '../../../common/errors/app.exception';
import {
  GoogleIdentityVerifier,
  GoogleVerifiedIdentity,
} from './google-identity.types';

/**
 * PHASE 10B — the inert verifier bound to `GOOGLE_IDENTITY_VERIFIER`
 * whenever `GOOGLE_AUTH_ENABLED` is not `"true"` (this repository's shipped
 * default) or no client id is configured. The `DisabledMidtransGateway` /
 * `NoopTranscodeQueueClient` pattern applied to the identity provider: it
 * makes NO network call, holds NO configuration, and rejects every
 * invocation with the same `GOOGLE_AUTH_DISABLED` (503) the service itself
 * answers.
 *
 * This is defense in depth, not the primary gate: `AuthIdentityService`
 * checks the flag BEFORE calling the verifier, so reaching one of these
 * rejections means a flag check was bypassed. Failing closed here means
 * even that hypothetical path can never reach an unconfigured verifier and
 * can never — under any misconfiguration — return a "verified" identity.
 */
export class DisabledGoogleIdentityVerifier implements GoogleIdentityVerifier {
  verifyIdToken(): Promise<GoogleVerifiedIdentity> {
    return Promise.reject(
      new AppException(
        AppErrorCode.GOOGLE_AUTH_DISABLED,
        'Google sign-in is not enabled on this server',
        HttpStatus.SERVICE_UNAVAILABLE,
      ),
    );
  }
}
