import { AUTH_PROVIDERS } from '../../auth/identity/auth-identity.constants';
import {
  DELETION_PROOF_METHODS,
  DELETION_PROOF_METHOD_BY_PROVIDER,
} from '../../auth/deletion/deletion-authorization.types';
import { checkV1AccountDeletionCoverage } from './v1-account-deletion-coverage';
import { EnvRecord } from './release-gate.types';

/**
 * The check that would have caught the V1 account-deletion defect.
 *
 * The defect was not a bug in any one file — every file was individually
 * correct. It was an omission ACROSS files: `passwordHash` became nullable,
 * two passwordless sign-in providers were added and made mandatory for V1,
 * and the deletion endpoint went on demanding a password. Nothing failed,
 * because nothing was asserting the relationship. These tests assert the
 * relationship.
 */

/** A candidate configuration in the posture V1 requires. */
const V1_ENV: EnvRecord = {
  GOOGLE_AUTH_ENABLED: 'true',
  WHATSAPP_AUTH_ENABLED: 'true',
};

describe('V1 account-deletion coverage', () => {
  describe('structural — every sign-in provider has an implemented proof', () => {
    it('passes for the shipped provider/proof mapping', () => {
      const findings = checkV1AccountDeletionCoverage(V1_ENV);

      expect(findings.every((finding) => finding.severity === 'PASS')).toBe(
        true,
      );
    });

    it('CRITICAL: reports one finding per supported sign-in provider — none may be silently absent', () => {
      const findings = checkV1AccountDeletionCoverage(V1_ENV);

      for (const provider of AUTH_PROVIDERS) {
        expect(
          findings.some(
            (finding) => finding.check === `account deletion: ${provider}`,
          ),
        ).toBe(true);
      }
    });

    it('CRITICAL: the provider -> proof map is TOTAL over AUTH_PROVIDERS, and every proof it names is implemented', () => {
      // The compiler already enforces totality (`Record<AuthProvider, ...>`).
      // This restates it as a runtime assertion so that a future change which
      // widened the map's type — rather than adding a real proof — still
      // fails here.
      for (const provider of AUTH_PROVIDERS) {
        const method = DELETION_PROOF_METHOD_BY_PROVIDER[provider];
        expect(method).toBeDefined();
        expect(DELETION_PROOF_METHODS).toContain(method);
      }
    });

    it('CRITICAL: names each provider’s proof in the report, so the release record states it in words', () => {
      const findings = checkV1AccountDeletionCoverage(V1_ENV);

      expect(
        findings.find((finding) => finding.check === 'account deletion: google')
          ?.detail,
      ).toContain('"google" proof');
      expect(
        findings.find(
          (finding) => finding.check === 'account deletion: whatsapp',
        )?.detail,
      ).toContain('"whatsapp" proof');
      expect(
        findings.find((finding) => finding.check === 'account deletion: email')
          ?.detail,
      ).toContain('"password" proof');
    });
  });

  describe('environmental — a required provider that cannot be verified has no proof path', () => {
    it('CRITICAL: BLOCKS a release with Google login disabled, naming the deletion consequence specifically', () => {
      const findings = checkV1AccountDeletionCoverage({
        ...V1_ENV,
        GOOGLE_AUTH_ENABLED: 'false',
      });

      const blocker = findings.find(
        (finding) => finding.severity === 'BLOCKER',
      );
      expect(blocker?.check).toBe('account deletion: google verifiable');
      expect(blocker?.detail).toContain('no way to delete itself');
    });

    it('CRITICAL: BLOCKS a release with WhatsApp login disabled', () => {
      const findings = checkV1AccountDeletionCoverage({
        ...V1_ENV,
        WHATSAPP_AUTH_ENABLED: 'false',
      });

      expect(
        findings.some(
          (finding) =>
            finding.severity === 'BLOCKER' &&
            finding.check === 'account deletion: whatsapp verifiable',
        ),
      ).toBe(true);
    });

    it('BLOCKS on an UNSET flag exactly as on an explicit "false" — the commonest way to ship this wrong', () => {
      const findings = checkV1AccountDeletionCoverage({});

      expect(
        findings.filter((finding) => finding.severity === 'BLOCKER'),
      ).toHaveLength(2);
    });

    it('never emits a secret or a raw value beyond the public flag names it grades', () => {
      const findings = checkV1AccountDeletionCoverage({
        ...V1_ENV,
        GOOGLE_AUTH_ENABLED: 'false',
        GOOGLE_OAUTH_CLIENT_IDS: 'a-client-id.apps.googleusercontent.com',
      });

      for (const finding of findings) {
        expect(finding.detail).not.toContain('googleusercontent.com');
      }
    });
  });
});
