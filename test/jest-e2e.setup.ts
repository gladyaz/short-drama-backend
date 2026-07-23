// Phase 8P, work unit 8P-2: e2e specs (test/*.e2e-spec.ts) boot the full Nest
// `AppModule` and exercise real HTTP endpoints backed by a real `PrismaService`
// connection — they create/query real rows, unlike the self-cleaning unit
// specs (src/**/*.spec.ts) that intentionally run against the dev database
// per existing repo precedent (see interactions.service.spec.ts). Running
// e2e specs against `DATABASE_URL` (the `short_drama_dev` database) would
// risk polluting dev data, so this Jest `setupFiles` entry runs before the
// test framework and any test file (including `@prisma/client`, which
// auto-loads `.env` and reads `DATABASE_URL` the first time it's required)
// is loaded, and redirects `DATABASE_URL` to `DATABASE_URL_TEST`
// (`short_drama_test`) for the duration of the e2e run only.
import 'dotenv/config';

if (!process.env.DATABASE_URL_TEST) {
  throw new Error(
    'DATABASE_URL_TEST is not set in .env — e2e tests must run against the ' +
      'dedicated short_drama_test database, not DATABASE_URL (dev). Copy ' +
      '.env.example and set DATABASE_URL_TEST before running npm run test:e2e.',
  );
}

process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
