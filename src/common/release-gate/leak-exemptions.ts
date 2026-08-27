/**
 * THE REVIEWED LEAK-SCAN EXEMPTION INVENTORY — the audit trail.
 *
 * Split out of `secret-leak-scan.ts` because it is a DIFFERENT KIND OF THING
 * from the code beside it. That file holds patterns and a classifier, which
 * are reviewed once and then rarely change. This one holds a judgement per
 * entry — "I read this line in context and it is not a production leak" — and
 * it is the file a reviewer should be able to open on its own, read top to
 * bottom, and disagree with a specific entry in.
 *
 * EVERY ENTRY WAS READ IN CONTEXT BEFORE IT WAS WRITTEN DOWN, and every one
 * states why. `secret-leak-scan.spec.ts` asserts that each is still REACHABLE
 * — that its file is in a scanned class, exists, and still contains the
 * anchor text — because a dead exemption reads as a reviewed justification
 * while covering nothing at all.
 */

/**
 * What an exemption is allowed to conclude.
 *
 * DELIBERATELY NARROWER than the scanner's own `LeakVerdict`, which also has
 * `LEAK`. An entry in this file exists to say "reviewed, and not a leak"; it
 * must be structurally incapable of DECLARING one, so that the inventory can
 * only ever downgrade a finding and never manufacture one.
 */
export type ExemptionVerdict = 'ALLOWED' | 'REVIEW';

/**
 * A known, reviewed match in release-bound source.
 *
 * `evidence` MUST APPEAR ON THE MATCHED LINE. Keying on a line number would
 * rot on the first edit above it; keying on the path alone would silently
 * cover a genuinely new leak added to the same file next month. Keying on the
 * line's own text means an exemption covers exactly the construct it was
 * written for.
 */
export interface LeakExemption {
  readonly path: string;
  readonly evidence: string;
  readonly category: string;
  readonly reason: string;
  /**
   * `ALLOWED` (the default when omitted) — reviewed and provably not
   * reachable as a production value. `REVIEW` — legitimate today, but worth
   * keeping on screen every run.
   */
  readonly verdict?: ExemptionVerdict;
  /**
   * Set when `evidence` names a MULTI-LINE DECLARATION whose every member is
   * covered — a rejection table such as `PLACEHOLDER_LABELS`, whose entries
   * are one literal per line.
   *
   * WITHOUT THIS, an exemption keyed on a line's own text can only ever
   * cover the declaration's FIRST line, and each of the nine placeholder
   * words below would need its own entry — nine entries that say the same
   * thing, and a tenth word added later that silently blocks the release.
   * With it, the exemption covers exactly the declaration and stops at its
   * closing bracket, so a leak added AFTER the table is still reported.
   */
  readonly spansDeclaration?: boolean;
}

/**
 * THE INVENTORY. Every entry was read in context before it was written down.
 * Grouped by why, not by file.
 */
export const RELEASE_GATE_LEAK_EXEMPTIONS: readonly LeakExemption[] = [
  // ---------------------------------------------------------------------
  // SECURITY CONTROLS: code that contains the string BECAUSE IT REJECTS IT.
  // Removing the literal would remove the defence.
  // ---------------------------------------------------------------------
  {
    path: 'src/common/net/public-host.ts',
    evidence: 'const LOOPBACK_HOSTS',
    spansDeclaration: true,
    category: 'security-control',
    reason:
      'The loopback allowlist `isPublicHostname` rejects. The literals ARE ' +
      'the rule; a URL is refused for matching one, never accepted.',
  },
  {
    path: 'src/common/production-preflight/preflight.ts',
    evidence: 'const RESERVED_SUFFIXES',
    spansDeclaration: true,
    category: 'security-control',
    reason:
      'The reserved-suffix rejection table `isPlaceholderHostname` matches ' +
      'against. Present so a placeholder hostname is BLOCKED.',
  },
  {
    path: 'src/common/production-preflight/preflight.ts',
    evidence: 'const RESERVED_DOMAINS',
    spansDeclaration: true,
    category: 'security-control',
    reason:
      'The reserved-domain rejection table. A configuration matching one of ' +
      'these is refused, never served.',
  },
  {
    path: 'src/common/production-preflight/preflight.ts',
    evidence: 'const PLACEHOLDER_LABELS',
    spansDeclaration: true,
    category: 'security-control',
    reason:
      'The template-placeholder rejection table `isPlaceholderHostname` and ' +
      '`firstPlaceholderSegment` match against. Every word here is present ' +
      'so that a configuration containing it is BLOCKED.',
  },
  {
    path: 'src/common/production-preflight/preflight.ts',
    evidence: "driver === 'fake'",
    category: 'security-control',
    reason:
      'The guard that BLOCKS a release configured with the non-delivering ' +
      'OTP driver.',
  },
  {
    path: 'src/config/env.validation.ts',
    evidence: "driver === 'fake'",
    category: 'security-control',
    reason:
      'The boot guard that refuses `WHATSAPP_OTP_PROVIDER_DRIVER=fake` ' +
      'outside NODE_ENV=development/test.',
  },
  {
    path: 'src/auth/identity/whatsapp/whatsapp-provider.factory.ts',
    evidence: "whatsappOtpDriver === 'fake'",
    category: 'security-control',
    reason:
      'The factory-level gate — the second of four independent gates on the ' +
      'fake provider. It selects the fake ONLY when the boot contract has ' +
      'already proved the environment is development or test.',
  },

  // ---------------------------------------------------------------------
  // OPERATOR MESSAGES: the string exists only inside text shown to a human
  // who is fixing a configuration. It is never a value the code uses.
  // ---------------------------------------------------------------------
  {
    path: 'src/config/env.validation.ts',
    evidence: '(for example https://api.example.com)',
    category: 'operator-message',
    reason:
      'Documentation-domain example inside a boot-failure message, so the ' +
      'operator is shown the SHAPE the variable must have.',
  },
  {
    path: 'src/config/env.validation.ts',
    evidence: 'https://admin.example.com',
    category: 'operator-message',
    reason: 'Documentation-domain example inside a CORS boot-failure message.',
  },
  {
    path: 'src/config/env.validation.ts',
    evidence: 'Refusing to boot with WHATSAPP_OTP_PROVIDER_DRIVER=fake',
    category: 'operator-message',
    reason: 'The refusal message itself names the driver it is refusing.',
  },
  {
    path: 'src/config/env.validation.ts',
    evidence: 'not exactly "development" or "test"',
    category: 'operator-message',
    reason: 'Continuation of the same refusal message.',
  },
  {
    path: 'src/config/env.validation.ts',
    evidence: 'production driver (Meta WhatsApp Cloud API)',
    category: 'operator-message',
    reason: 'Names the unimplemented-driver options in a boot-failure message.',
  },
  {
    path: 'src/common/production-preflight/preflight.ts',
    evidence: 'delivers NO message and retains',
    category: 'operator-message',
    reason: 'The preflight BLOCKER text explaining why the fake driver fails.',
  },
  {
    path: 'scripts/production-smoke-test.ts',
    evidence: 'API_BASE_URL is not set. Usage:',
    category: 'operator-message',
    reason:
      'Usage help printed when the operator forgets the variable. A CLI ' +
      'usage line, never a default.',
  },

  // ---------------------------------------------------------------------
  // DEVELOPMENT-ONLY SURFACES: real code, provably unreachable in
  // production because the boot contract refuses the configuration that
  // would reach it.
  // ---------------------------------------------------------------------
  {
    path: 'src/auth/identity/whatsapp/whatsapp-local-fake.provider.ts',
    evidence: 'Fake WhatsApp OTP issued',
    category: 'dev-only-provider',
    reason:
      'The in-memory OTP provider. Four independent gates keep it out of ' +
      'production, the first being `validateWhatsAppConfig` refusing to boot ' +
      'with driver=fake outside development/test.',
  },
  {
    path: 'src/auth/identity/whatsapp/whatsapp-otp.service.ts',
    evidence: 'import { LocalFakeWhatsAppOtpProvider }',
    category: 'dev-only-provider',
    reason:
      'A type-level import of the dev provider, for the instanceof check ' +
      'that is itself one of the four gates.',
  },
  {
    path: 'src/auth/identity/whatsapp/whatsapp-provider.factory.ts',
    evidence: "from './whatsapp-local-fake.provider'",
    category: 'dev-only-provider',
    reason: 'Module path of the dev provider the factory conditionally binds.',
  },
  {
    path: 'src/auth/identity/whatsapp/whatsapp-otp.types.ts',
    evidence: 'WHATSAPP_OTP_DRIVERS',
    spansDeclaration: true,
    category: 'driver-vocabulary',
    reason:
      'The closed list of driver NAMES. Naming a driver is what lets the ' +
      'validator refuse it.',
  },
  {
    path: 'src/auth/identity/auth-identity.service.ts',
    evidence: 'devCode: issued.devCode',
    category: 'dev-only-surface',
    reason:
      'Passthrough of a field that is `undefined` unless DEV_TOOLS_ENABLED ' +
      'is true AND NODE_ENV is development/test — a combination ' +
      '`validateDevToolsNodeEnv` refuses to boot in production.',
  },
  {
    path: 'src/auth/deletion/deletion-authorization.service.ts',
    evidence: 'devCode: issued.devCode',
    category: 'dev-only-surface',
    reason:
      'V1 provider account deletion: the SAME passthrough as ' +
      'auth-identity.service.ts above, in the second route that issues a ' +
      'WhatsApp challenge (POST /users/me/deletion/whatsapp/otp). The value ' +
      'comes from the same `exposeDevCode`, behind the same two gates — ' +
      'DEV_TOOLS_ENABLED true AND NODE_ENV development/test, a combination ' +
      '`validateDevToolsNodeEnv` refuses to boot in production — plus the ' +
      'third gate that only `LocalFakeWhatsAppOtpProvider` can supply a ' +
      'readable code at all, and it cannot be constructed in production.',
  },
  {
    path: 'src/auth/auth.service.ts',
    evidence: 'devToken: rawToken',
    category: 'dev-only-surface',
    reason:
      'The password-reset counterpart of devCode, and the field devCode was ' +
      'modelled on. Returned only when DEV_TOOLS_ENABLED is true AND ' +
      'NODE_ENV is development/test — a combination the boot contract ' +
      'refuses in production.',
  },
  {
    path: 'src/auth/auth.types.ts',
    evidence: 'devToken?: string',
    category: 'dev-only-surface',
    reason: 'Optional response field, absent in every production response.',
  },
  {
    path: 'src/auth/identity/auth-identity.types.ts',
    evidence: 'devCode?: string',
    category: 'dev-only-surface',
    reason: 'Optional response field, absent in every production response.',
  },
  {
    path: 'src/auth/identity/whatsapp/whatsapp-otp.service.ts',
    evidence: 'devCode?: string',
    category: 'dev-only-surface',
    reason: 'Optional field on the internal issue result.',
  },
  {
    path: 'src/auth/identity/whatsapp/whatsapp-otp.service.ts',
    evidence: 'devCode: this.exposeDevCode(code)',
    category: 'dev-only-surface',
    reason:
      '`exposeDevCode` returns undefined unless devToolsEnabled AND NODE_ENV ' +
      'is development/test.',
  },

  // ---------------------------------------------------------------------
  // NOT CREDENTIALS: values whose NAME matches a credential pattern but
  // whose CONTENT is a label.
  // ---------------------------------------------------------------------
  {
    path: 'src/auth/auth.constants.ts',
    evidence: 'PASSWORD_RESET_TOKEN_HASH_DOMAIN',
    category: 'domain-separation-label',
    reason:
      'A public hash domain-separation prefix, mixed into a digest so two ' +
      'token kinds cannot collide. It is not secret and grants nothing.',
  },
  {
    path: 'src/health/storage-readiness.service.ts',
    evidence: "OBJECT_STORAGE_SECRET_ACCESS_KEY: 'secretAccessKey'",
    category: 'config-field-map',
    reason:
      'Maps an environment variable NAME to the config field NAME, so a ' +
      'readiness probe can report which variable is missing. No value.',
  },

  // ---------------------------------------------------------------------
  // KEPT ON SCREEN: legitimate, and still worth seeing every single run.
  // ---------------------------------------------------------------------
  {
    path: 'src/config/configuration.ts',
    evidence: "PUBLIC_BASE_URL ?? 'http://localhost:3000'",
    category: 'development-fallback',
    verdict: 'REVIEW',
    reason:
      'A development default in a release-bound file. It is PROVABLY ' +
      'unreachable in production — `validateProductionPublicUrls` throws ' +
      'when PUBLIC_BASE_URL is absent or not an https public origin under ' +
      'NODE_ENV=production, so the process cannot start and fall back to ' +
      'this. Reported every run because it is the one compiled-in loopback ' +
      'URL in the release path, and its safety depends entirely on that ' +
      'validator continuing to exist.',
  },
];
