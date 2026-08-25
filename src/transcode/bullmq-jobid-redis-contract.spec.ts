import { existsSync, readFileSync } from 'fs';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import {
  config as loadEnvFileIntoProcessEnv,
  parse as parseEnvFileText,
} from 'dotenv';
import {
  buildTranscodeJobId,
  TRANSCODE_BACKOFF_BASE_DELAY_MS,
} from './transcode.constants';
import { TranscodeJobPayload } from './transcode.types';

/**
 * The ONE opt-in, real-Redis contract test for the transcode queue.
 *
 * ## Why this file has to exist
 *
 * Every other test that touches the queue `jest.mock`s `bullmq` and `ioredis`
 * wholesale (see `bullmq-transcode-queue.client.spec.ts`'s own doc comment,
 * which states that as a deliberate safety property). That is exactly how the
 * defect fixed in `2381117` survived all the way to a live run: the
 * deterministic jobId was `<videoId>:<processingVersion>`, and BullMQ rejects
 * any custom jobId containing `:` that does not split into exactly 3 parts
 * (`Error: Custom Id cannot contain :`). A mocked `Queue.add` cannot reject
 * anything, so a fully green unit suite proved nothing about the one property
 * the whole dedupe design rests on — that the id we generate is an id BullMQ
 * will actually accept.
 *
 * This file closes that specific hole and nothing else. It is not a general
 * queue integration suite.
 *
 * ## Why it is opt-in rather than part of `npm test`
 *
 * Making the default unit suite require a live Redis would make CI brittle for
 * a repo whose entire test architecture is deliberately built around never
 * needing one. So this follows the SAME command-line-only opt-in convention the
 * repo already uses for its other real-dependency proofs
 * (`hls-r2-smoke.spec.ts`, `storage-r2-media-smoke.spec.ts`): the suite
 * `describe.skip`s unless explicitly opted in, an integrity guard that ALWAYS
 * runs makes a silent skip impossible, and the opt-in may never come from
 * `.env`.
 *
 *   npm run test:redis-contract
 *
 * ## Safety
 *
 * - **Never production Redis.** The gate refuses any `REDIS_URL` whose host is
 *   not a loopback address, so this can only ever run against a local/dev
 *   instance even if a production URL is exported into the shell.
 * - **Never the real queue.** Every run uses a fresh, uniquely-named queue
 *   (`media-transcode-contract-<pid>-<random>`), so it can never enqueue work a
 *   real worker would pick up, and can never collide with a concurrent run.
 *   The jobId validation this file pins lives in BullMQ's `Job.addJob` and is
 *   entirely independent of the queue's name, so a dedicated queue proves the
 *   contract exactly as well as the real one would.
 * - **Deterministic cleanup.** `afterAll` obliterates the run's own queue and
 *   asserts no `bull:<thisQueue>:*` key survives.
 */

/**
 * True when the opt-in flag is declared, with any non-empty value, in the
 * `.env` file on disk — checked BEFORE `.env` is loaded, mirroring
 * `hls-r2-smoke.spec.ts::isOptInDeclaredInEnvFile` exactly (kept as a separate
 * copy scoped to THIS flag, per that file's own stated rationale, so neither
 * gate can be weakened by a change to the other).
 */
function isOptInDeclaredInEnvFile(): boolean {
  try {
    if (!existsSync('.env')) {
      return false;
    }

    const declaredValue: string | undefined = parseEnvFileText(
      readFileSync('.env', 'utf8'),
    ).RUN_REDIS_QUEUE_CONTRACT;

    return declaredValue !== undefined && declaredValue !== '';
  } catch {
    return false;
  }
}

/**
 * Only a loopback Redis is ever acceptable here. Checked on the URL's HOST, not
 * on a substring of the whole string, so a production URL that merely happens
 * to contain the text "localhost" somewhere (a password, a database name)
 * cannot talk its way past this.
 */
function isLoopbackRedisUrl(rawUrl: string): boolean {
  try {
    const { hostname, protocol } = new URL(rawUrl);

    if (protocol !== 'redis:' && protocol !== 'rediss:') {
      return false;
    }

    return (
      hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
    );
  } catch {
    return false;
  }
}

const declaredInEnvFile = isOptInDeclaredInEnvFile();

if (process.env.RUN_REDIS_QUEUE_CONTRACT === '1' && !declaredInEnvFile) {
  loadEnvFileIntoProcessEnv();
}

const isOptedIn = process.env.RUN_REDIS_QUEUE_CONTRACT === '1';
const redisUrl = process.env.REDIS_URL;
const redisUrlIsLoopback =
  redisUrl !== undefined && isLoopbackRedisUrl(redisUrl);

const gateResolved = isOptedIn && !declaredInEnvFile && redisUrlIsLoopback;
const maybeDescribe = gateResolved ? describe : describe.skip;

const REDIS_TEST_TIMEOUT_MS = 30_000;

/**
 * A queue name unique to THIS process, so concurrent runs (and the real
 * `media-transcode` queue a live worker may be consuming) can never interfere.
 */
const CONTRACT_QUEUE_NAME = `media-transcode-contract-${process.pid}-${Math.random()
  .toString(36)
  .slice(2, 10)}`;

describe('BullMQ jobId real-Redis contract — opt-in integrity guard (always runs)', () => {
  it('does not silently skip when RUN_REDIS_QUEUE_CONTRACT=1', () => {
    if (!isOptedIn) {
      expect(maybeDescribe).toBe(describe.skip);
      return;
    }

    expect(redisUrl).toBeDefined();
    expect(redisUrlIsLoopback).toBe(true);
    expect(gateResolved).toBe(true);
  });

  it('refuses an opt-in declared in the .env file instead of on the command line', () => {
    if (declaredInEnvFile) {
      throw new Error(
        'RUN_REDIS_QUEUE_CONTRACT is declared with a value inside the .env ' +
          'file. This proof opts in from the COMMAND LINE ONLY — e.g. ' +
          '`npm run test:redis-contract` — and never from .env. Remove the ' +
          'line from .env and pass the variable on the command line instead.',
      );
    }

    expect(declaredInEnvFile).toBe(false);
  });
});

maybeDescribe('BullMQ jobId real-Redis contract', () => {
  let connection: IORedis;
  let queue: Queue<TranscodeJobPayload>;

  /** The exact job options `BullmqTranscodeQueueClient.add` uses in production. */
  function productionJobOptions(jobId: string) {
    return {
      jobId,
      attempts: 3,
      backoff: {
        type: 'exponential' as const,
        delay: TRANSCODE_BACKOFF_BASE_DELAY_MS,
      },
    };
  }

  /**
   * `maxRetriesPerRequest: null` is BullMQ's own documented requirement for the
   * connection it is handed, but on its own it means an unreachable Redis
   * produces an ENDLESS `ECONNREFUSED` reconnect loop rather than a failure —
   * the suite simply hangs until Jest's timeout, with the real cause buried in
   * repeated connection noise. `retryStrategy` bounds that: after
   * `MAX_CONNECT_ATTEMPTS` it returns `null`, which tells ioredis to stop
   * retrying and surface the error, and `connectTimeout` bounds each attempt.
   */
  const MAX_CONNECT_ATTEMPTS = 3;
  const CONNECT_TIMEOUT_MS = 2_000;
  const PING_TIMEOUT_MS = 8_000;

  beforeAll(async () => {
    connection = new IORedis(redisUrl!, {
      maxRetriesPerRequest: null,
      connectTimeout: CONNECT_TIMEOUT_MS,
      retryStrategy: (times) =>
        times > MAX_CONNECT_ATTEMPTS ? null : CONNECT_TIMEOUT_MS,
    });

    // Fail FAST and legibly when Redis is not actually there, instead of
    // letting the first `queue.add` hang until the test timeout.
    try {
      await Promise.race([
        connection.ping(),
        new Promise((_, reject) =>
          setTimeout(
            () =>
              reject(new Error(`ping timed out after ${PING_TIMEOUT_MS}ms`)),
            PING_TIMEOUT_MS,
          ).unref(),
        ),
      ]);
    } catch (error) {
      throw new Error(
        'This opt-in proof requires a reachable local Redis, and REDIS_URL ' +
          `did not answer PING (${error instanceof Error ? error.message : String(error)}). ` +
          'Start the local instance (e.g. `brew services start redis`) and ' +
          're-run `npm run test:redis-contract`. The URL itself is never logged.',
      );
    }

    queue = new Queue<TranscodeJobPayload>(CONTRACT_QUEUE_NAME, { connection });
  }, REDIS_TEST_TIMEOUT_MS);

  afterAll(async () => {
    // `beforeAll` may have thrown before either was constructed (unreachable
    // Redis) — cleaning up what does not exist must not mask that real error.
    if (!connection) {
      return;
    }

    let survivingKeys: string[] = [];

    try {
      if (queue) {
        await queue.obliterate({ force: true });
        survivingKeys = await connection.keys(`bull:${CONTRACT_QUEUE_NAME}:*`);
        await queue.close();
      }
    } finally {
      await connection.quit();
    }

    // Asserted AFTER the connections are closed so a cleanup failure can never
    // also leak a socket and hang the Jest worker.
    expect(survivingKeys).toEqual([]);
  }, REDIS_TEST_TIMEOUT_MS);

  it(
    'accepts the real deterministic jobId and stores it in Redis unchanged (regression for "Custom Id cannot contain :")',
    async () => {
      const videoId = 'media-redis-contract-a1b2c3';
      const jobId = buildTranscodeJobId(videoId, 1);
      const payload: TranscodeJobPayload = {
        videoId,
        processingVersion: 1,
      };

      // Before 2381117 this call THREW against the installed BullMQ.
      const job = await queue.add(
        CONTRACT_QUEUE_NAME,
        payload,
        productionJobOptions(jobId),
      );

      expect(job.id).toBe(jobId);

      // Prove it genuinely reached Redis, rather than only that `add` resolved.
      const readBack = await queue.getJob(jobId);
      expect(readBack).toBeDefined();
      expect(readBack!.id).toBe(jobId);
      expect(readBack!.data).toEqual(payload);
      expect(readBack!.opts.attempts).toBe(3);
    },
    REDIS_TEST_TIMEOUT_MS,
  );

  it(
    'dedupes a repeated enqueue of the same (videoId, processingVersion) into ONE job — the property TranscodeReconcilerService relies on',
    async () => {
      const videoId = 'media-redis-contract-dedupe';
      const jobId = buildTranscodeJobId(videoId, 7);
      const payload: TranscodeJobPayload = {
        videoId,
        processingVersion: 7,
      };

      await queue.add(
        CONTRACT_QUEUE_NAME,
        payload,
        productionJobOptions(jobId),
      );
      await queue.add(
        CONTRACT_QUEUE_NAME,
        payload,
        productionJobOptions(jobId),
      );

      const matching = (
        await queue.getJobs(['waiting', 'delayed', 'active'])
      ).filter((job) => job.id === jobId);

      expect(matching).toHaveLength(1);
    },
    REDIS_TEST_TIMEOUT_MS,
  );

  it(
    'treats two processingVersions of the same video as two distinct jobs',
    async () => {
      const videoId = 'media-redis-contract-versions';
      const firstJobId = buildTranscodeJobId(videoId, 1);
      const secondJobId = buildTranscodeJobId(videoId, 2);

      await queue.add(
        CONTRACT_QUEUE_NAME,
        { videoId, processingVersion: 1 },
        productionJobOptions(firstJobId),
      );
      await queue.add(
        CONTRACT_QUEUE_NAME,
        { videoId, processingVersion: 2 },
        productionJobOptions(secondJobId),
      );

      expect(firstJobId).not.toBe(secondJobId);
      await expect(queue.getJob(firstJobId)).resolves.toBeDefined();
      await expect(queue.getJob(secondJobId)).resolves.toBeDefined();
    },
    REDIS_TEST_TIMEOUT_MS,
  );

  /**
   * The negative control that pins WHY the separator had to change. If a future
   * BullMQ upgrade ever relaxes this rule, this test fails and tells us the
   * constraint we designed around no longer holds — rather than leaving a
   * mysterious `__v` separator with no surviving justification.
   */
  it(
    'still rejects the OLD colon-separated jobId shape — pinning the BullMQ constraint the separator exists to satisfy',
    async () => {
      const legacyJobId = 'media-redis-contract-legacy:1';

      await expect(
        queue.add(
          CONTRACT_QUEUE_NAME,
          { videoId: 'media-redis-contract-legacy', processingVersion: 1 },
          productionJobOptions(legacyJobId),
        ),
      ).rejects.toThrow(/Custom Id cannot contain :/);
    },
    REDIS_TEST_TIMEOUT_MS,
  );
});
