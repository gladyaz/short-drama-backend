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
   * HLS sample used for playback testing). Served by the API exactly as
   * before - never hidden server-side, never deleted - so internal tooling
   * and QA keep working. Clients that present a consumer catalog are the
   * ones expected to exclude it.
   */
  QA_FIXTURE = 'qa_fixture',
}
