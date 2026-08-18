import { readFileSync } from 'fs';
import { join } from 'path';
import { DEFAULT_PUT_URL_EXPIRY_SECONDS } from '../../storage/storage.constants';
import {
  SERIES_COVER_ORPHAN_GRACE_MS,
  SERIES_COVER_ORPHAN_LIST_PAGE_SIZE,
  SERIES_COVER_ORPHAN_MAX_PAGES,
  SERIES_COVER_ORPHAN_MAX_REPORTED_CANDIDATES,
  SERIES_COVER_UPLOAD_WINDOW_MS,
} from './series-cover-orphan.constants';

/**
 * Slice "SERIES COVER ORPHAN CLEANUP LIFECYCLE": these assertions pin the
 * POLICY, not the implementation — the numbers a reviewer would otherwise
 * have to take on trust from a comment.
 */
describe('series cover orphan constants', () => {
  it('uses a 24-hour grace window', () => {
    expect(SERIES_COVER_ORPHAN_GRACE_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('keeps the grace window far larger than the presigned-upload window it derives from', () => {
    // The derivation this policy claims: bytes can only land inside the
    // presigned PUT lifetime, so the grace window must dominate it by a wide
    // margin. If someone raises the presign expiry, this fails loudly rather
    // than the sweep quietly becoming aggressive.
    expect(SERIES_COVER_UPLOAD_WINDOW_MS).toBe(
      DEFAULT_PUT_URL_EXPIRY_SECONDS * 1000,
    );
    expect(SERIES_COVER_ORPHAN_GRACE_MS).toBeGreaterThan(
      SERIES_COVER_UPLOAD_WINDOW_MS * 24,
    );
  });

  it('bounds one listing page at the S3/R2 protocol maximum', () => {
    expect(SERIES_COVER_ORPHAN_LIST_PAGE_SIZE).toBe(1000);
  });

  it('bounds a single sweep to a finite number of pages', () => {
    expect(SERIES_COVER_ORPHAN_MAX_PAGES).toBeGreaterThan(0);
    expect(Number.isFinite(SERIES_COVER_ORPHAN_MAX_PAGES)).toBe(true);
  });

  it('bounds the enumerated candidate detail list', () => {
    expect(SERIES_COVER_ORPHAN_MAX_REPORTED_CANDIDATES).toBeGreaterThan(0);
    expect(Number.isFinite(SERIES_COVER_ORPHAN_MAX_REPORTED_CANDIDATES)).toBe(
      true,
    );
  });

  it('exposes NO environment variable that could shrink the grace window', () => {
    // A policy claim worth enforcing structurally: an operator must not be
    // able to make the sweep more aggressive from outside the source tree.
    // Reading the file is deliberate — a `process.env` assertion would only
    // prove the variable is unset in THIS shell, not that no code reads one.
    const source = readFileSync(
      join(__dirname, 'series-cover-orphan.constants.ts'),
      'utf8',
    );

    expect(source).not.toContain('process.env');
  });
});
