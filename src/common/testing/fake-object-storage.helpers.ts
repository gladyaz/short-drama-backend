import { StorageService } from '../../storage/storage.service';
import {
  ListObjectPageOptions,
  ObjectListPage,
} from '../../storage/storage.types';
import { SeriesCoverOrphanStorage } from '../../series/cover-orphans/series-cover-orphan.types';

/**
 * Slice "SERIES COVER ORPHAN CLEANUP LIFECYCLE": an in-memory, fully
 * deterministic stand-in for the object store.
 *
 * WHY A FAKE RATHER THAN A `jest.fn()` MOCK. The orphan sweep's behavior is
 * defined by the INTERACTION between listing and deleting across pages: a
 * repeated apply run must be idempotent, a delete must actually remove the
 * key from the next listing, and pagination must hand back a stable order.
 * A per-call `mockResolvedValueOnce` script cannot express any of that
 * without the test restating the implementation's own call sequence, which
 * would make the test pass for the wrong reasons.
 *
 * NO NETWORK, EVER. This class holds a `Map` and nothing else — it
 * constructs no `S3Client`, reads no credential, and resolves no hostname.
 * `src/**\/testing/**` is excluded from `tsconfig.build.json`, so it cannot
 * reach `dist/` either.
 *
 * It implements `SeriesCoverOrphanStorage`, which is itself
 * `Pick<StorageService, ...>` — so if a production signature changes, this
 * file stops compiling rather than silently drifting away from the real
 * thing.
 */
export class FakeObjectStorage implements SeriesCoverOrphanStorage {
  /** key -> lastModified. Insertion order is irrelevant; listing sorts. */
  private readonly objects = new Map<string, Date | undefined>();

  /** Keys whose `deleteObject` must reject, simulating a storage-side failure. */
  private readonly failingKeys = new Set<string>();

  /** Every `deleteObject` argument, in call order — including ones that threw. */
  readonly deleteAttempts: string[] = [];

  /** Every successful `deleteObject` argument, in call order. */
  readonly deletedKeys: string[] = [];

  /** Every `listObjectPageByPrefix` call, in order — for pagination assertions. */
  readonly listCalls: { prefix: string; options?: ListObjectPageOptions }[] =
    [];

  /**
   * Optional deterministic barrier fired immediately BEFORE a key is
   * removed. Exists so a concurrency test can interleave a database write at
   * an exact point in the sweep without sleeping or racing a timer.
   */
  onBeforeDelete?: (key: string) => Promise<void> | void;

  /**
   * Seeds one object. `lastModified` is `undefined`-able on purpose so the
   * "listing reported no timestamp" branch is reachable from a test.
   */
  put(key: string, lastModified?: Date): void {
    this.objects.set(key, lastModified);
  }

  /** Marks `key` as one whose deletion rejects. The object itself stays present. */
  failDeletesFor(key: string): void {
    this.failingKeys.add(key);
  }

  has(key: string): boolean {
    return this.objects.has(key);
  }

  /** Every key currently stored, sorted — the post-conditions a test asserts on. */
  keys(): string[] {
    return [...this.objects.keys()].sort();
  }

  get size(): number {
    return this.objects.size;
  }

  /**
   * Lexicographically ordered, `maxKeys`-bounded page, with the
   * continuation token being the last key of the page — the same
   * "resume after this key" contract S3's opaque token provides, expressed
   * in a form a test can read. A token is returned ONLY when more keys
   * actually remain, mirroring `StorageService.listObjectPageByPrefix`'s
   * `IsTruncated`-gated behavior.
   */
  listObjectPageByPrefix(
    prefix: string,
    options?: ListObjectPageOptions,
  ): Promise<ObjectListPage> {
    this.listCalls.push({ prefix, options });

    const maxKeys = options?.maxKeys ?? 1000;
    const after = options?.continuationToken;

    const matching = [...this.objects.keys()]
      .filter((key) => key.startsWith(prefix))
      .filter((key) => after === undefined || key > after)
      .sort();

    const pageKeys = matching.slice(0, maxKeys);
    const hasMore = matching.length > pageKeys.length;

    return Promise.resolve({
      entries: pageKeys.map((key) => ({
        key,
        lastModified: this.objects.get(key),
      })),
      nextContinuationToken: hasMore
        ? pageKeys[pageKeys.length - 1]
        : undefined,
    });
  }

  /**
   * Removes exactly one key. Removing an absent key RESOLVES (it does not
   * throw) — S3/R2 `DeleteObject` is idempotent, and the sweep's own
   * idempotency claim depends on that being modeled faithfully.
   */
  async deleteObject(key: string): Promise<void> {
    this.deleteAttempts.push(key);

    if (this.onBeforeDelete) {
      await this.onBeforeDelete(key);
    }

    if (this.failingKeys.has(key)) {
      throw new Error(`FakeObjectStorage: simulated delete failure for ${key}`);
    }

    this.objects.delete(key);
    this.deletedKeys.push(key);
  }
}

/**
 * Widens the fake to the full `StorageService` type for constructor
 * injection. A single assertion in ONE place (rather than an
 * `as unknown as StorageService` scattered through every spec), and a safe
 * one: `StorageService` is assignable to `SeriesCoverOrphanStorage`, so the
 * two types genuinely overlap and the two picked methods are still checked
 * structurally against the real signatures.
 */
export function asStorageService(
  fake: SeriesCoverOrphanStorage,
): StorageService {
  return fake as StorageService;
}
