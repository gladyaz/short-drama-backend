/**
 * Response DTOs for the Phase 9 (work unit 9-B2) Like/Save endpoints. Shapes
 * are fixed by the frozen contract recorded in the workspace `DECISIONS.md`
 * ("Phase 9 approved..." entry) and must not diverge from it.
 */
export interface LikeResponseDto {
  videoId: string;
  isLiked: boolean;
  likeCount: number;
}

export interface SaveResponseDto {
  videoId: string;
  isSaved: boolean;
}

export interface UserInteractionDto {
  videoId: string;
  isLiked: boolean;
  isSaved: boolean;
}
