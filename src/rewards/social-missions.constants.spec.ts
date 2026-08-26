import {
  deriveAccountHandle,
  findSocialMissionDefinition,
  rejectSocialUrl,
  resolveSocialMissionCatalog,
  SOCIAL_MISSION_DEFINITIONS,
} from './social-missions.constants';

/**
 * Work unit "REWARDS V1 EARN AND SPEND": the URL rules the boot contract, the
 * runtime catalog and the production preflight all share.
 *
 * PURE, so every case is exercised without a database, a Nest module, or a
 * mutated `process.env` that a parallel spec could observe — the catalog
 * resolver takes its environment as an argument for exactly this reason.
 */
describe('social mission catalog', () => {
  const instagram = findSocialMissionDefinition('task_social_instagram')!;
  const tiktok = findSocialMissionDefinition('task_social_tiktok')!;
  const youtube = findSocialMissionDefinition('task_social_youtube')!;

  describe('catalog shape', () => {
    it('CRITICAL: covers the three platforms V1 requires', () => {
      const platforms = SOCIAL_MISSION_DEFINITIONS.map(
        (mission) => mission.platform,
      );

      expect(platforms).toEqual(
        expect.arrayContaining(['INSTAGRAM', 'TIKTOK', 'YOUTUBE']),
      );
    });

    it('gives every mission a stable, unique id and a positive reward', () => {
      const ids = SOCIAL_MISSION_DEFINITIONS.map((mission) => mission.id);

      expect(new Set(ids).size).toBe(ids.length);

      for (const mission of SOCIAL_MISSION_DEFINITIONS) {
        expect(mission.id).toMatch(/^task_social_[a-z]+$/);
        expect(mission.rewardPoints).toBeGreaterThan(0);
        expect(Number.isInteger(mission.rewardPoints)).toBe(true);
        expect(mission.allowedHosts.length).toBeGreaterThan(0);
      }
    });
  });

  describe('rejectSocialUrl', () => {
    it('accepts a real profile URL on the platform own domain', () => {
      expect(
        rejectSocialUrl('https://www.instagram.com/redpanda', instagram),
      ).toBeNull();
      expect(
        rejectSocialUrl('https://www.tiktok.com/@redpanda', tiktok),
      ).toBeNull();
      expect(
        rejectSocialUrl('https://www.youtube.com/@redpanda', youtube),
      ).toBeNull();
    });

    it('CRITICAL: refuses a host that is not the platform own', () => {
      // The whole point of the allowlist: this URL is well-formed https and
      // would otherwise be handed to every client and opened in an external
      // browser under Red Panda branding.
      expect(
        rejectSocialUrl('https://instagram.evil.example/redpanda', instagram),
      ).toBe('WRONG_HOST');

      // A real platform, but the WRONG one for this mission.
      expect(
        rejectSocialUrl('https://www.tiktok.com/@redpanda', instagram),
      ).toBe('WRONG_HOST');
    });

    it('CRITICAL: refuses cleartext http', () => {
      expect(
        rejectSocialUrl('http://www.instagram.com/redpanda', instagram),
      ).toBe('NOT_HTTPS');
    });

    it('refuses a localhost or example URL, via the host rule', () => {
      expect(
        rejectSocialUrl('https://localhost:3000/redpanda', instagram),
      ).toBe('WRONG_HOST');
      expect(rejectSocialUrl('https://example.com/redpanda', instagram)).toBe(
        'WRONG_HOST',
      );
    });

    it('refuses the platform home page — a right host is not a profile', () => {
      expect(rejectSocialUrl('https://www.instagram.com/', instagram)).toBe(
        'NO_PROFILE_PATH',
      );
      expect(rejectSocialUrl('https://www.instagram.com', instagram)).toBe(
        'NO_PROFILE_PATH',
      );
    });

    it('refuses a value that is not a URL, and one that is not a string', () => {
      expect(rejectSocialUrl('redpanda', instagram)).toBe('NOT_A_URL');
      expect(rejectSocialUrl('', instagram)).toBe('NOT_A_STRING');
      expect(rejectSocialUrl(undefined, instagram)).toBe('NOT_A_STRING');
      expect(rejectSocialUrl(42, instagram)).toBe('NOT_A_STRING');
    });

    it('tolerates surrounding whitespace, which a .env file makes easy to add', () => {
      expect(
        rejectSocialUrl('  https://www.instagram.com/redpanda  ', instagram),
      ).toBeNull();
    });
  });

  describe('deriveAccountHandle', () => {
    it('derives a handle from a single-segment profile path', () => {
      expect(deriveAccountHandle('https://www.instagram.com/redpanda')).toBe(
        '@redpanda',
      );
      expect(deriveAccountHandle('https://www.tiktok.com/@redpanda')).toBe(
        '@redpanda',
      );
      expect(deriveAccountHandle('https://www.instagram.com/redpanda/')).toBe(
        '@redpanda',
      );
    });

    it('returns null when the URL carries no handle to show', () => {
      // An opaque channel id is not a handle, and rendering "@UCabc123" beside
      // a tile would be worse than rendering the platform name alone.
      expect(
        deriveAccountHandle('https://www.youtube.com/channel/UCabc123'),
      ).toBeNull();
      expect(deriveAccountHandle('https://www.instagram.com/')).toBeNull();
      expect(deriveAccountHandle('not-a-url')).toBeNull();
    });
  });

  describe('resolveSocialMissionCatalog', () => {
    it('offers nothing when nothing is configured', () => {
      const catalog = resolveSocialMissionCatalog({});

      expect(catalog.missions).toHaveLength(0);
      expect(catalog.rejected).toHaveLength(0);
    });

    it('offers exactly the platforms that are configured', () => {
      const catalog = resolveSocialMissionCatalog({
        REWARDS_SOCIAL_INSTAGRAM_URL: 'https://www.instagram.com/redpanda',
        REWARDS_SOCIAL_YOUTUBE_URL: 'https://www.youtube.com/@redpanda',
        // TikTok and Facebook deliberately unset.
      });

      expect(
        catalog.missions.map((mission) => mission.definition.platform),
      ).toEqual(['INSTAGRAM', 'YOUTUBE']);
      expect(catalog.missions[0].accountHandle).toBe('@redpanda');
      expect(catalog.rejected).toHaveLength(0);
    });

    it('treats a blank value as unset rather than as an error', () => {
      const catalog = resolveSocialMissionCatalog({
        REWARDS_SOCIAL_INSTAGRAM_URL: '   ',
      });

      expect(catalog.missions).toHaveLength(0);
      expect(catalog.rejected).toHaveLength(0);
    });

    it('CRITICAL: never offers a mission whose URL is unusable', () => {
      const catalog = resolveSocialMissionCatalog({
        REWARDS_SOCIAL_INSTAGRAM_URL: 'https://instagram.evil.example/redpanda',
      });

      // A mission that is dropped is dropped — it is never served with a bad
      // URL, and never served with a null one either.
      expect(catalog.missions).toHaveLength(0);
      expect(catalog.rejected).toEqual([
        { definition: instagram, rejection: 'WRONG_HOST' },
      ]);
    });
  });
});
