/**
 * Response/request DTO shapes for the Phase 9 (work unit 9-B2) watch-progress
 * endpoints. Fixed by the frozen contract recorded in the workspace
 * `DECISIONS.md` ("Phase 9 approved..." entry) — must not diverge from it.
 */
export interface ProgressResponseDto {
  seriesId: string;
  videoId: string;
  episodeNumber: number;
  positionSeconds: number;
  durationSeconds?: number;
}
