import { TranscodeJobPayload } from './transcode.types';

// `@typescript-eslint/no-explicit-any` is off repo-wide (eslint.config.mjs)
// — these `any`-typed mock signatures only record call args for the
// assertions below; a narrower type here would fight `expect.objectContaining`/
// `expect.anything()` (themselves typed loosely by @types/jest) for no
// benefit, since nothing in this file relies on the mocks' own parameter
// types for correctness.
const mockQueueAdd = jest.fn<(...args: any[]) => Promise<void>>();
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
    return { add: mockQueueAdd };
  }),
}));

jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation((...args: unknown[]) => {
    mockIORedisConstructor(...args);
    return {};
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
    mockQueueConstructor.mockReset();
    mockIORedisConstructor.mockReset();
  });

  it('constructs an IORedis client with lazyConnect + maxRetriesPerRequest: null, and a Queue named "media-transcode"', () => {
    new BullmqTranscodeQueueClient('redis://example.invalid:6379');

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
    );
    const payload: TranscodeJobPayload = {
      videoId: 'media-abc',
      processingVersion: 1,
    };

    await client.add('media-abc:1', payload);

    expect(mockQueueAdd).toHaveBeenCalledWith(
      TRANSCODE_QUEUE_NAME,
      payload,
      expect.objectContaining({ jobId: 'media-abc:1' }),
    );
  });
});
