import { TranscodeJobPayload } from './transcode.types';

// `@typescript-eslint/no-explicit-any` is off repo-wide (eslint.config.mjs)
// — these `any`-typed mock signatures only record call args for the
// assertions below; a narrower type here would fight `expect.objectContaining`/
// `expect.anything()` (themselves typed loosely by @types/jest) for no
// benefit, since nothing in this file relies on the mocks' own parameter
// types for correctness.
const mockQueueAdd = jest.fn<(...args: any[]) => Promise<void>>();
const mockQueueClose = jest.fn<() => Promise<void>>();
const mockRedisQuit = jest.fn<() => Promise<string>>();
const mockQueueConstructor = jest.fn<(name: string, opts: any) => void>();
const mockIORedisConstructor = jest.fn<(...args: any[]) => void>();

/**
 * Slice 11N: both `bullmq` and `ioredis` are FULLY mocked (Jest hoists these
 * `jest.mock` calls above the imports below automatically) — this file
 * never constructs a real `Queue`/`IORedis` object and never opens a real
 * Redis connection, satisfying the hard prohibition even for this
 * wrapper-class-level unit test of `BullmqTranscodeQueueClient` itself.
 */
jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation((name: string, opts: unknown) => {
    mockQueueConstructor(name, opts);
    return { add: mockQueueAdd, close: mockQueueClose };
  }),
}));

jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation((...args: unknown[]) => {
    mockIORedisConstructor(...args);
    return { quit: mockRedisQuit };
  }),
}));

// Textually after the mocks above for readability only — Jest hoists every
// `jest.mock(...)` call (via ts-jest's babel-plugin-jest-hoist integration)
// above ALL imports in this file regardless of source order, so the module
// under test still resolves the mocked `bullmq`/`ioredis` modules, not the
// real ones.
import { BullmqTranscodeQueueClient } from './bullmq-transcode-queue.client';
import { TRANSCODE_QUEUE_NAME } from './transcode.constants';

describe('BullmqTranscodeQueueClient', () => {
  beforeEach(() => {
    mockQueueAdd.mockReset().mockResolvedValue(undefined);
    mockQueueClose.mockReset().mockResolvedValue(undefined);
    mockRedisQuit.mockReset().mockResolvedValue('OK');
    mockQueueConstructor.mockReset();
    mockIORedisConstructor.mockReset();
  });

  it('constructs an IORedis client with lazyConnect + maxRetriesPerRequest: null, and a Queue named "media-transcode"', () => {
    new BullmqTranscodeQueueClient('redis://example.invalid:6379', 3);

    expect(mockIORedisConstructor).toHaveBeenCalledWith(
      'redis://example.invalid:6379',
      expect.objectContaining({
        lazyConnect: true,
        maxRetriesPerRequest: null,
      }),
    );
    expect(mockQueueConstructor).toHaveBeenCalledTimes(1);
    const [queueName, queueOpts] = mockQueueConstructor.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(queueName).toBe(TRANSCODE_QUEUE_NAME);
    expect(queueOpts).toHaveProperty('connection');
  });

  it('add() calls the underlying Queue.add with the exact jobId and payload', async () => {
    const client = new BullmqTranscodeQueueClient(
      'redis://example.invalid:6379',
      3,
    );
    const payload: TranscodeJobPayload = {
      videoId: 'media-abc',
      processingVersion: 1,
    };

    await client.add('media-abc__v1', payload);

    expect(mockQueueAdd).toHaveBeenCalledWith(
      TRANSCODE_QUEUE_NAME,
      payload,
      expect.objectContaining({ jobId: 'media-abc__v1' }),
    );
  });

  // Slice 11P: bounded retry with exponential backoff, sourced from
  // `TranscodeConfig.maxAttempts` at construction time.
  it('add() passes the constructor-supplied maxAttempts as BullMQ attempts, with exponential backoff', async () => {
    const client = new BullmqTranscodeQueueClient(
      'redis://example.invalid:6379',
      5,
    );
    const payload: TranscodeJobPayload = {
      videoId: 'media-abc',
      processingVersion: 1,
    };

    await client.add('media-abc__v1', payload);

    expect(mockQueueAdd).toHaveBeenCalledWith(
      TRANSCODE_QUEUE_NAME,
      payload,
      expect.objectContaining({
        attempts: 5,
        backoff: { type: 'exponential', delay: 60_000 },
      }),
    );
  });
  /**
   * `lazyConnect` defers the first connection, it does not prevent one — the
   * `Queue`'s Redis socket is an open libuv handle that keeps the Node event
   * loop alive until something closes it. Before this, nothing did: with
   * `TRANSCODE_ENABLED=true` every process that merely constructed this
   * client finished its work and then hung forever instead of exiting, which
   * also defeated `app.close()`-based graceful shutdown.
   */
  describe('onModuleDestroy', () => {
    it('closes the queue and quits the Redis connection so the process can exit', async () => {
      const client = new BullmqTranscodeQueueClient(
        'redis://example.invalid:6379',
        3,
      );

      await client.onModuleDestroy();

      expect(mockQueueClose).toHaveBeenCalledTimes(1);
      expect(mockRedisQuit).toHaveBeenCalledTimes(1);
    });

    it('still quits the Redis connection when closing the queue throws', async () => {
      mockQueueClose.mockRejectedValue(new Error('queue close failed'));
      const client = new BullmqTranscodeQueueClient(
        'redis://example.invalid:6379',
        3,
      );

      await expect(client.onModuleDestroy()).resolves.toBeUndefined();

      expect(mockRedisQuit).toHaveBeenCalledTimes(1);
    });

    it('never throws when quitting the Redis connection fails — a shutdown-time Redis error must not crash a clean exit', async () => {
      mockRedisQuit.mockRejectedValue(new Error('quit failed'));
      const client = new BullmqTranscodeQueueClient(
        'redis://example.invalid:6379',
        3,
      );

      await expect(client.onModuleDestroy()).resolves.toBeUndefined();
    });
  });
});
