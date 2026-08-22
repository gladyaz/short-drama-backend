import { IsString, Length, Matches } from 'class-validator';

/**
 * Body of `POST /rewards/redemptions`.
 *
 * NOTE WHAT IS ABSENT: no cost, no points, no balance, no duration. The
 * client sends INTENT ONLY — which offer, and a key identifying this attempt
 * — and every economic value is resolved server-side from
 * `REWARD_REDEMPTION_OFFERS`. This is the mobile domain contract's
 * "server-authoritative balance" rule expressed in the DTO itself: there is
 * no field a client could use to influence what it is charged or what it
 * receives. `ValidationPipe` runs with `forbidNonWhitelisted: true`
 * app-wide, so a request that invents one is rejected outright rather than
 * silently ignored.
 */
export class RedeemRewardDto {
  @IsString()
  @Length(1, 64)
  offerId!: string;

  /**
   * Client-supplied idempotency key, unique per redemption ATTEMPT.
   *
   * Client-supplied here — unlike the daily check-in, whose key the server
   * derives from the calendar date — because redeeming the same offer twice
   * is a legitimate thing to do, so only the client knows whether a second
   * request is a retry of the first or a genuine new purchase. A UUID per
   * button press is the intended usage.
   *
   * Constrained to a conservative character set and length: it is stored in
   * a unique index and echoed into a ledger `idempotencyKey`, so allowing
   * arbitrary unbounded text would let a caller bloat those indexes.
   */
  @IsString()
  @Length(8, 128)
  @Matches(/^[A-Za-z0-9_:-]+$/, {
    message:
      'idempotencyKey may contain only letters, digits, underscore, hyphen and colon',
  })
  idempotencyKey!: string;
}
