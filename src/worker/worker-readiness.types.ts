/**
 * Slice 11O — the secret-free readiness payload the worker entry logs at
 * boot and exits `0` after. `config` is a presence/flag SUMMARY only —
 * booleans and enum-like strings, never a value that could be a secret or an
 * absolute internal path (mirrors `TranscodeReadinessService`'s
 * "config-presence only, never a live probe" convention,
 * `../health/transcode-readiness.service.ts`).
 */
export interface WorkerReadinessSummary {
  ffmpegAvailable: boolean;
  ffprobeAvailable: boolean;
  ffmpegVersion?: string;
  ffprobeVersion?: string;
  config: {
    nodeEnv: string | undefined;
    storageDriver: string;
    transcodeEnabled: boolean;
  };
}
