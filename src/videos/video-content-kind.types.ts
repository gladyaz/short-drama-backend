/**
 * Explicit catalog content classification for `Video.contentKind`.
 *
 * WHY THIS EXISTS: the mobile-visible DTO previously carried no field that
 * distinguished real, user-facing drama content from internal QA fixtures,
 * so the two synthetic rows in the catalog (the 11R HLS sample and a
 * disposable admin-upload test row) rendered on Home and Discover as if they
 * were ordinary dramas. Every field a client could have inferred that from is
 * unreliable, and each was rejected deliberately:
 *
 *   - `title` / `channelName`  - display strings; a rename silently breaks it.
 *   - `sourceLanguage`         - means "original language of the content",
 *                                not "is this real". A legitimate
 *                                Indonesian-original drama is `id` too.
 *   - `storageKey === ''`      - an empty LOCAL storage key is exactly how
 *                                R2-backed media is represented (see
 *                                `VideosService#findAll`'s OR clause), so
 *                                filtering on it would hide real R2 content.
 *   - `width`/`height`         - optional by contract; absence proves nothing.
 *   - numeric `seriesId`       - a naming convention, not a contract.
 *
 * Classification is therefore DECLARED and persisted, never inferred - at
 * rest, over the wire, and on the client. Mirrors the DB column's plain
 * `String` type (same reasoning as `Video.category`, `Video.lifecycleState`
 * and `Entitlement.tier`: no Postgres enum, so adding a kind later needs no
 * schema migration), but every value that flows through the videos module is
 * one of these two.
 *
 * DISTINCT FROM `MediaLifecycleState`, which answers "is this row publishable
 * yet" (draft/ready/published/unpublished/failed). A QA fixture can be
 * perfectly `published` and streamable - that is the point of it - and must
 * stay that way for internal playback testing. This enum answers a different
 * question: "should an ordinary viewer see this as catalog content".
 */
export enum VideoContentKind {
  /** Real, user-facing drama content. The default for every catalog row. */
  DRAMA = 'drama',
  /**
   * Internal technical fixture kept in the catalog on purpose (e.g. the 11R
   * HLS sample used for playback testing, and the `series-hlsproof` rows
   * `scripts/hls-real-media-proof.ts` seeds). Never deleted.
   *
   * WHERE IT IS AND IS NOT SERVED (updated by the V1 integration; this
   * comment previously said clients were expected to exclude it, which was
   * true before `/series` started filtering and is no longer the whole
   * rule):
   *
   *  - LISTING routes EXCLUDE it server-side: `GET /videos/feed`,
   *    `GET /series`, `GET /series/:id`'s episode list. A consumer catalog
   *    must not depend on every client remembering to filter, and a fixture
   *    is indistinguishable from an episode once it is in the list.
   *  - DIRECT-ADDRESSING routes still serve it unchanged: `GET /videos/:id`,
   *    `/videos/:id/playback`, `/videos/:id/stream`. Internal tooling and QA
   *    depend on exactly this — the HLS proof harness exercises
   *    `/videos/:id/playback` against seeded fixture rows — and hiding a row
   *    whose id you must already know buys nothing.
   */
  QA_FIXTURE = 'qa_fixture',
}
