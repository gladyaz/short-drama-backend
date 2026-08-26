/**
 * Work unit "REWARDS V1 EARN AND SPEND": the social-follow mission catalog,
 * and the rules that decide whether a configured destination URL is a real
 * Red Panda profile or a template placeholder.
 *
 * ---------------------------------------------------------------------------
 * THE TRUTHFULNESS RULE THIS FILE EXISTS TO ENCODE
 *
 * Instagram, TikTok, YouTube and Facebook expose no API that answers "did
 * user X follow page Y" for an arbitrary user. This backend therefore CANNOT
 * verify a follow, and nothing in this module claims that it does:
 *
 *   - the ledger reason is `EXTERNAL_SOCIAL_ACTION`, not `VERIFIED_FOLLOW`;
 *   - the wire field is `verification: 'USER_CONFIRMED'`, sent on every
 *     social task so a client cannot render it as anything stronger;
 *   - `docs/rewards-api-contract.md` §6 states the limitation in the same
 *     words.
 *
 * What the server DOES know, and all it knows, is: it handed this account a
 * destination URL at a recorded instant (`POST /rewards/missions/:id/open`),
 * and the account came back and confirmed at a later one
 * (`POST /rewards/missions/:id/claim`). That is a user-confirmed external
 * action. Paying a modest, once-per-account reward for it is a product
 * decision; PRETENDING it is a verified follow would be a lie told in a
 * column name, which is the kind that survives long after everyone who knew
 * better has moved on.
 *
 * If a trusted verification integration is ever added, the honest upgrade
 * path is a NEW verification value (`PLATFORM_VERIFIED`) alongside a new
 * ledger reason — not a redefinition of this one.
 *
 * ---------------------------------------------------------------------------
 * WHY THE URLS ARE ENVIRONMENT CONFIGURATION AND NOT CONSTANTS
 *
 * The reward VALUES are economics and live in `rewards.constants.ts` with
 * everything else economic. The destination URLs are DEPLOYMENT facts — they
 * differ between a staging tenant and the real Red Panda accounts, and a
 * marketing team changing a handle must not need a code release.
 *
 * They are read from `process.env` by `RewardsMissionsService`, once, in its
 * constructor — the `AdsConfigService` precedent rather than the
 * `configuration.ts` one. That choice is deliberate: `configuration.ts`
 * imports nothing at all (it is a bare factory over `process.env`), so
 * putting these there would mean re-declaring the four variable names and
 * the four host allowlists beside the ones in this file — a second source of
 * truth for which missions exist. `AdsConfigService` already established
 * that a feature with optional, per-field, warn-on-invalid variables parses
 * them in its own module.
 *
 * `env.validation.ts` still gates the boot: a variable that is SET but
 * malformed fails startup, so the resolution below never has to choose
 * between a bad value and a silent omission in a process that is running.
 *
 * A mission with no configured URL is NOT served with a dead button. It is
 * omitted from the snapshot entirely and its claim route answers
 * `REWARD_MISSION_UNAVAILABLE`, because a tile that opens nothing is worse
 * than a tile that is not there.
 */

/**
 * The platforms V1 supports. Matches the mobile `SocialPlatform` union
 * already in `rewards.types.ts` — this is not a new vocabulary, it is the
 * existing one gaining a working implementation.
 */
export type SocialMissionPlatform =
  'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE' | 'FACEBOOK';

export interface SocialMissionDefinition {
  /**
   * Stable mission id. Follows the `task_social_<platform>` shape the
   * foundation slice's placeholder catalog already used, so the tiles the
   * mobile app has been rendering since then keep their identity and a
   * user's claim history survives this work unit.
   */
  readonly id: string;
  readonly platform: SocialMissionPlatform;
  /** The env var carrying this platform's Red Panda profile URL. */
  readonly envKey: string;
  /** Server-decided reward. Never sent by, or influenced by, a client. */
  readonly rewardPoints: number;
  /**
   * Hostnames a URL for this platform may legitimately use.
   *
   * WHY AN ALLOWLIST RATHER THAN "any https URL". `REWARDS_SOCIAL_TIKTOK_URL`
   * is served to every client and opened in an external browser on the
   * user's device. An operator typo — or a compromised env store — that
   * pointed it at an attacker's domain would turn the Rewards Center into a
   * phishing funnel wearing Red Panda's branding, and every affected user
   * would have been sent there BY US. Pinning the host to the platform the
   * tile claims to be means the worst a bad value can do is 404 on the real
   * platform.
   */
  readonly allowedHosts: readonly string[];
}

/**
 * INSTAGRAM, TIKTOK and YOUTUBE are the three V1 requires. FACEBOOK is
 * included because the foundation slice's placeholder catalog already served
 * a `task_social_facebook` tile and the mobile `SocialPlatform` union already
 * carries the member — dropping it here would silently remove a tile that has
 * been on screen for weeks. Like the other three it appears only when its URL
 * is configured, so a deployment that does not want it simply leaves the
 * variable unset.
 */
export const SOCIAL_MISSION_DEFINITIONS: readonly SocialMissionDefinition[] = [
  {
    id: 'task_social_instagram',
    platform: 'INSTAGRAM',
    envKey: 'REWARDS_SOCIAL_INSTAGRAM_URL',
    rewardPoints: 50,
    allowedHosts: ['instagram.com', 'www.instagram.com'],
  },
  {
    id: 'task_social_tiktok',
    platform: 'TIKTOK',
    envKey: 'REWARDS_SOCIAL_TIKTOK_URL',
    rewardPoints: 50,
    allowedHosts: ['tiktok.com', 'www.tiktok.com', 'm.tiktok.com'],
  },
  {
    id: 'task_social_youtube',
    platform: 'YOUTUBE',
    envKey: 'REWARDS_SOCIAL_YOUTUBE_URL',
    rewardPoints: 50,
    allowedHosts: [
      'youtube.com',
      'www.youtube.com',
      'm.youtube.com',
      'youtu.be',
    ],
  },
  {
    id: 'task_social_facebook',
    platform: 'FACEBOOK',
    envKey: 'REWARDS_SOCIAL_FACEBOOK_URL',
    rewardPoints: 50,
    allowedHosts: ['facebook.com', 'www.facebook.com', 'm.facebook.com'],
  },
];

export function findSocialMissionDefinition(
  missionId: string,
): SocialMissionDefinition | undefined {
  return SOCIAL_MISSION_DEFINITIONS.find((mission) => mission.id === missionId);
}

/**
 * How long after `POST /rewards/missions/:id/open` a claim is accepted.
 *
 * NOT AN ANTI-FRAUD CONTROL, and it would be dishonest to describe it as
 * one — a script can wait five seconds. It is the smallest server-side
 * expression of the actual product flow ("tap → the profile opens → you come
 * back"), and it is what makes a claim that never opened the link refusable.
 * The load-bearing control against farming is the once-per-account ledger
 * key, which no amount of waiting defeats.
 */
export const SOCIAL_MISSION_MIN_DWELL_SECONDS = 5;

/** Reasons a configured social URL is refused. Machine-readable, for tests and callers. */
export type SocialUrlRejection =
  'NOT_A_STRING' | 'NOT_A_URL' | 'NOT_HTTPS' | 'WRONG_HOST' | 'NO_PROFILE_PATH';

/**
 * Whether `raw` is a usable destination URL for `mission`, and if not, why.
 *
 * Deliberately a PURE function returning a reason rather than a throwing
 * validator: `env.validation.ts` turns a rejection into a boot failure, the
 * config factory turns it into "this mission is not offered", and the
 * preflight turns it into a report line. Three callers, three reactions, one
 * rule — which is what keeps the boot contract and the runtime catalog from
 * ever disagreeing about which missions exist.
 */
export function rejectSocialUrl(
  raw: unknown,
  mission: SocialMissionDefinition,
): SocialUrlRejection | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return 'NOT_A_STRING';
  }

  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return 'NOT_A_URL';
  }

  // Android 9+ refuses cleartext, and a follow link the phone silently
  // refuses to open is a mission no one can ever complete.
  if (parsed.protocol !== 'https:') {
    return 'NOT_HTTPS';
  }

  if (!mission.allowedHosts.includes(parsed.hostname.toLowerCase())) {
    return 'WRONG_HOST';
  }

  // `https://instagram.com/` is a valid https URL on the right host and is
  // still not a profile — it is the platform's home page, which is what a
  // half-filled template leaves behind.
  if (profileSegments(parsed).length === 0) {
    return 'NO_PROFILE_PATH';
  }

  return null;
}

/**
 * The account handle to display beside the tile, or `null` when the URL
 * shape does not carry one (`youtube.com/channel/UC…` is an opaque id, not a
 * handle worth showing).
 *
 * DERIVED, NOT CONFIGURED, deliberately: a separate `..._HANDLE` variable
 * per platform is a second source of truth that will eventually disagree
 * with the URL beside it, and the disagreement would be invisible until a
 * user noticed the label and the destination naming different accounts.
 */
export function deriveAccountHandle(destinationUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(destinationUrl);
  } catch {
    return null;
  }

  const segments = profileSegments(parsed);

  if (segments.length !== 1) {
    return null;
  }

  const handle = segments[0].replace(/^@/, '');
  return handle.length > 0 ? `@${handle}` : null;
}

/**
 * A social mission that this deployment has actually configured, with its
 * destination resolved and its handle derived.
 */
export interface ResolvedSocialMission {
  readonly definition: SocialMissionDefinition;
  readonly destinationUrl: string;
  readonly accountHandle: string | null;
}

export interface SocialMissionCatalog {
  readonly missions: readonly ResolvedSocialMission[];
  /**
   * Missions whose variable is SET but unusable, with the reason. Empty in
   * any process that booted, because `env.validation.ts` refuses to start
   * with a malformed value — it is populated here so the service can log the
   * discrepancy if one ever appears anyway (a value mutated after boot, a
   * test constructing the catalog directly), rather than silently dropping a
   * mission an operator believes they configured.
   */
  readonly rejected: ReadonlyArray<{
    readonly definition: SocialMissionDefinition;
    readonly rejection: SocialUrlRejection;
  }>;
}

/**
 * Builds the configured social-mission catalog from an environment record.
 *
 * PURE, and takes the environment as an argument rather than reading
 * `process.env` itself, so every case — none configured, one configured,
 * a malformed value — is testable without mutating global state in a test
 * that runs beside others.
 *
 * AN UNSET VARIABLE IS NOT AN ERROR. It means "this deployment does not run
 * that mission", and the mission is omitted from the snapshot entirely. A
 * deployment with no social URLs at all serves no social tiles and is
 * completely valid — which is what makes the feature safe to roll out one
 * platform at a time.
 */
export function resolveSocialMissionCatalog(
  env: Record<string, string | undefined>,
): SocialMissionCatalog {
  const missions: ResolvedSocialMission[] = [];
  const rejected: Array<{
    definition: SocialMissionDefinition;
    rejection: SocialUrlRejection;
  }> = [];

  for (const definition of SOCIAL_MISSION_DEFINITIONS) {
    const raw = env[definition.envKey];

    // Unset or blank: this deployment does not run this mission.
    if (raw === undefined || raw.trim().length === 0) {
      continue;
    }

    const rejection = rejectSocialUrl(raw, definition);

    if (rejection !== null) {
      rejected.push({ definition, rejection });
      continue;
    }

    const destinationUrl = raw.trim();
    missions.push({
      definition,
      destinationUrl,
      accountHandle: deriveAccountHandle(destinationUrl),
    });
  }

  return { missions, rejected };
}

/** Non-empty path segments, e.g. `/@redpanda/` -> `['@redpanda']`. */
function profileSegments(parsed: URL): string[] {
  return parsed.pathname.split('/').filter((segment) => segment.length > 0);
}
