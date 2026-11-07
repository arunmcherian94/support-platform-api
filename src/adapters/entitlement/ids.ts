import { readFileSync } from 'node:fs';
import { parseCsv } from './csv.js';

/**
 * Account ID normalisation (ADR-0003 §3): the crosswalk first, for aliases that
 * formatting cannot reconcile (`ACC-77` is ACC-007, not ACC-077), then the
 * canonical format. Names are never used to match accounts.
 */

const DEFAULT_CROSSWALK = new URL(
  '../../../mocks/fixtures/entitlement/id-crosswalk.csv',
  import.meta.url,
);

/** Case-insensitive `ACC` prefix, optional hyphen, digits. */
const CANONICAL_SHAPE = /^ACC-?(\d+)$/i;

/** `ACC-` plus the digits, zero-padded to at least three; null if the ID has another shape. */
export function canonicalFormat(id: string): string | null {
  const digits = CANONICAL_SHAPE.exec(id.trim())?.[1];
  return digits === undefined ? null : `ACC-${digits.padStart(3, '0')}`;
}

/**
 * Canonical ID for a source ID, or null when it fits neither the crosswalk nor
 * the canonical format (the caller reports it as a data-quality event).
 * The crosswalk matches the exact source ID; its target is format-normalised too.
 */
export function normalizeAccountId(
  sourceId: string,
  crosswalk: ReadonlyMap<string, string>,
): string | null {
  const mapped = crosswalk.get(sourceId.trim());
  return canonicalFormat(mapped ?? sourceId);
}

/**
 * Parses a `source_id,canonical_id` crosswalk. It stands in for a master data
 * management mapping (ADR-0003); a malformed crosswalk fails loudly at start-up,
 * because a silently dropped alias would mis-join accounts.
 */
export function parseCrosswalk(text: string): Map<string, string> {
  const [header, ...rows] = parseCsv(text);
  if (header?.length !== 2 || header[0] !== 'source_id' || header[1] !== 'canonical_id') {
    throw new Error('crosswalk header must be source_id,canonical_id');
  }
  const map = new Map<string, string>();
  for (const [index, row] of rows.entries()) {
    const [source, target] = row;
    const canonical = target === undefined ? null : canonicalFormat(target);
    if (row.length !== 2 || source === undefined || source.trim() === '' || canonical === null) {
      throw new Error(`crosswalk row ${String(index + 2)} is malformed`);
    }
    map.set(source.trim(), canonical);
  }
  return map;
}

/** Loads the crosswalk file; defaults to the fixture in `mocks/fixtures/entitlement/`. */
export function loadCrosswalk(path: string | URL = DEFAULT_CROSSWALK): Map<string, string> {
  return parseCrosswalk(readFileSync(path, 'utf8'));
}
