import {
  PreflightFinding,
  runProductionPreflight,
} from '../src/common/production-preflight/preflight';

/**
 * PRODUCTION HTTPS READINESS: judges a candidate production configuration
 * WITHOUT deploying it.
 *
 *   npm run production:preflight
 *
 * Reads the ambient environment only. It opens no connection, runs no
 * query, touches no bucket, and writes nothing — so it is safe to run
 * repeatedly, from CI or a laptop, against real production values. It never
 * prints a secret: findings name variables and echo only values that are
 * public by nature (URLs, flags, hostnames).
 *
 * The rules live in `src/common/production-preflight/preflight.ts` so they
 * are unit tested; this file is only presentation and an exit code.
 *
 * Exit codes:  0 = no blockers (warnings may still be present)
 *              1 = at least one blocker
 *
 * `dotenv/config` is NOT imported on purpose. A preflight that silently
 * absorbed the developer's local `.env` would grade the wrong
 * configuration and pass. Supply the real values explicitly, for example:
 *
 *   env $(grep -v '^#' .env.production | xargs) npm run production:preflight
 */

const ICON: Record<PreflightFinding['severity'], string> = {
  PASS: '✓',
  WARNING: '!',
  BLOCKER: '✗',
};

function main(): void {
  const report = runProductionPreflight(process.env);

  const order: Array<PreflightFinding['severity']> = [
    'BLOCKER',
    'WARNING',
    'PASS',
  ];

  for (const severity of order) {
    const group = report.findings.filter(
      (finding) => finding.severity === severity,
    );
    if (group.length === 0) {
      continue;
    }

    console.log(`\n${severity}:`);
    for (const finding of group) {
      console.log(
        `  ${ICON[severity]} ${finding.check}\n      ${finding.detail}`,
      );
    }
  }

  console.log(
    `\n${report.blockers} blocker(s), ${report.warnings} warning(s).`,
  );

  if (!report.ok) {
    console.error(
      'This configuration is NOT ready for production. Fix every BLOCKER above.\n' +
        'Nothing was deployed, connected to, or modified by this command.',
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    'No blockers. This configuration would boot and serve over HTTPS.\n' +
      'Review any warnings, then verify the DEPLOYED origin with:\n' +
      '  API_BASE_URL=https://<origin> npm run smoke:production',
  );
}

main();
