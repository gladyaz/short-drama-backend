import {
  AUTH_PROVIDERS,
  AuthProvider,
} from '../../auth/identity/auth-identity.constants';
import {
  DELETION_PROOF_METHOD_BY_PROVIDER,
  DELETION_PROOF_METHODS,
  DeletionProofMethod,
} from '../../auth/deletion/deletion-authorization.types';
import { V1_FEATURE_CONTRACT } from './v1-feature-contract';
import { EnvRecord, GateFinding } from './release-gate.types';

/**
 * RED PANDA V1 — EVERY SUPPORTED SIGN-IN METHOD HAS A DELETION PATH.
 *
 * ===================== WHY THIS CHECK EXISTS AT ALL =====================
 *
 * It is written against a real, shipped defect rather than a hypothetical
 * one. `POST /users/me/deletion` demanded the account's current password and
 * refused when `User.passwordHash` was `null`. Nothing was broken about that
 * on the day it shipped — every account had a password. Then Phase 10B made
 * `passwordHash` nullable and added Google and WhatsApp sign-in, and V1 made
 * BOTH of those required. From that moment the product could create accounts
 * it could not delete, and every automated signal stayed green: the build
 * compiled, the deletion tests passed (they all used password accounts), the
 * preflight approved the configuration, and the feature contract confirmed
 * both login providers were enabled — which was exactly the problem, since
 * enabling a provider is what created the undeletable accounts.
 *
 * The gap was found by a human reading the public website's privacy page.
 * This check is what makes that unnecessary a second time.
 *
 * ======================== WHAT IT ACTUALLY CHECKS ========================
 *
 * TWO PROPERTIES, one structural and one environmental.
 *
 *   1. STRUCTURAL (always): every provider in `AUTH_PROVIDERS` maps to a
 *      `DeletionProofMethod` that the deletion layer actually implements.
 *      This cannot regress silently, because `DELETION_PROOF_METHOD_BY_PROVIDER`
 *      is a TOTAL `Record<AuthProvider, DeletionProofMethod>` — adding a
 *      fourth provider without deciding how its accounts delete themselves
 *      fails to compile. This function re-states it at runtime anyway, so
 *      the RELEASE REPORT says it in words an operator can read, rather than
 *      leaving it as a property only the compiler knows about.
 *
 *   2. ENVIRONMENTAL (per candidate configuration): for every login provider
 *      the V1 feature contract requires to be ENABLED, this configuration
 *      must actually enable it — because
 *      `DeletionAuthorizationService.availableMethods` will not offer a
 *      provider proof this server cannot verify. A release with
 *      `GOOGLE_AUTH_ENABLED=false` does not merely ship a dead login button
 *      (which the feature contract already blocks on): it also ships
 *      Google-created accounts with no deletion path, which is a distinct
 *      and worse consequence, and one no other check states.
 *
 * ==================== WHAT IT DELIBERATELY DOES NOT DO ====================
 *
 * It opens no connection, reads no database, and calls no route. It grades a
 * SHAPE — the provider list, the proof map, and one environment record — so
 * it is safe to run anywhere, repeatedly, exactly like every other inline
 * step in this directory. Proof that each path actually WORKS is the job of
 * `deletion-authorization.service.spec.ts` and
 * `account-deletion-providers.e2e-spec.ts`, which exercise all three
 * end-to-end; a gate check cannot substitute for those and does not pretend
 * to.
 */

/** The V1 feature-contract ids whose provider must also be able to self-delete. */
const V1_LOGIN_PROVIDER_REQUIREMENTS: Readonly<
  Record<string, Extract<AuthProvider, 'google' | 'whatsapp'>>
> = {
  'google-login': 'google',
  'whatsapp-login': 'whatsapp',
};

export function checkV1AccountDeletionCoverage(env: EnvRecord): GateFinding[] {
  const findings: GateFinding[] = [];

  // --- 1. Structural: every provider maps to an implemented proof ---
  const implemented = new Set<DeletionProofMethod>(DELETION_PROOF_METHODS);

  for (const provider of AUTH_PROVIDERS) {
    const method = DELETION_PROOF_METHOD_BY_PROVIDER[provider];

    if (!implemented.has(method)) {
      findings.push({
        severity: 'BLOCKER',
        check: `account deletion: ${provider}`,
        detail:
          `Sign-in provider "${provider}" maps to deletion proof "${method}", ` +
          'which the deletion layer does not implement. An account created ' +
          'through this provider could not be deleted by its owner.',
      });
      continue;
    }

    findings.push({
      severity: 'PASS',
      check: `account deletion: ${provider}`,
      detail:
        `Accounts created with "${provider}" confirm deletion with the ` +
        `"${method}" proof at POST /users/me/deletion.`,
    });
  }

  // --- 2. Environmental: a required provider that is off has no proof path ---
  for (const requirement of V1_FEATURE_CONTRACT) {
    const provider = V1_LOGIN_PROVIDER_REQUIREMENTS[requirement.id];
    if (provider === undefined) {
      continue;
    }

    if (!requirement.satisfiedBy(env[requirement.envKey])) {
      findings.push({
        severity: 'BLOCKER',
        check: `account deletion: ${provider} verifiable`,
        detail:
          `${requirement.envKey} is not "${requirement.expected}", so this ` +
          `server cannot verify a ${provider} deletion proof. ` +
          `GET /users/me/deletion/methods would omit "${DELETION_PROOF_METHOD_BY_PROVIDER[provider]}", ` +
          `leaving any ${provider}-only account with no way to delete itself.`,
      });
    }
  }

  return findings;
}
