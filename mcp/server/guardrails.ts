/**
 * Guardrails for what crosses the MCP boundary (S5 §2.5).
 *
 * Detection here is best-effort. The real defences are structural: tools act
 * on one case at a time, escalation needs a human, the token is the user's
 * scopes ∩ the agent's, and nothing in tool output can approve anything.
 */
import { maskPersonalData } from '../../src/observability/logger.js';

export const MAX_ROWS = 20;
export const MAX_TEXT_CHARS = 300;
export const MAX_RESPONSE_BYTES = 8 * 1024;

/** Upstream free text, marked so the model treats it as data. */
export interface UntrustedText {
  untrusted: true;
  text: string;
  /** Heuristic hits on likely injected instructions; absent when none. */
  untrustedContentFlags?: string[];
  truncated?: true;
}

// Zero-width, bidi-control and other invisible format characters, by code point
// (written as numbers so the source itself contains no invisible characters).
const INVISIBLE_RANGES: [number, number][] = [
  [0xad, 0xad],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
];
const INVISIBLE = new RegExp(
  `[${INVISIBLE_RANGES.map(([from, to]) => `${String.fromCodePoint(from)}-${String.fromCodePoint(to)}`).join('')}]`,
  'g',
);
// C0/C1 controls except tab and newline.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;
const HTML_COMMENT = /<!--[\s\S]*?(?:-->|$)/g;
const URL_PATTERN = /\b(https?|ftp):\/\/([^\s/?#<>()[\]"'`]+)([^\s<>()"'`]*)/gi;

const INJECTION_PATTERNS: [flag: string, pattern: RegExp][] = [
  [
    'instruction_override',
    /\b(ignore|disregard|forget)\b.{0,40}\b(previous|prior|above|earlier|all)\b.{0,20}\b(instructions?|prompts?|rules?)\b/i,
  ],
  ['role_change', /\byou are now\b|\bact as\b|\bnew instructions?\b/i],
  ['fake_system', /(^|\n|\s)(system|assistant|developer)\s*:/i],
  [
    'fake_approval',
    /\b(approv(al|ed)\s+(granted|given|confirmed)|already\s+(approved|confirmed)|user\s+(has\s+)?confirmed)\b/i,
  ],
  ['bulk_action', /\b(escalate|close|delete|comment on)\s+(all|every)\b/i],
  [
    'tool_directive',
    /\b(call|use|invoke|run)\s+(the\s+)?(tool|function)\b|\bescalate_case\b|\badd_case_comment\b/i,
  ],
];

/** NFKC plus invisible and control characters removed: what detection runs on. */
function canonical(text: string): string {
  return text.normalize('NFKC').replace(INVISIBLE, '').replace(CONTROL, '');
}

/** `https://evil.example/x` → `hxxps://evil[.]example/x`: readable, not clickable or fetchable. */
export function defangUrls(text: string): string {
  return text.replace(URL_PATTERN, (_match, scheme: string, host: string, rest: string) => {
    const defangedScheme = scheme.toLowerCase().replace(/^http/, 'hxxp').replace(/^ftp/, 'fxp');
    return `${defangedScheme}://${host.replace(/\./g, '[.]')}${rest}`;
  });
}

export function injectionFlags(text: string): string[] {
  const value = canonical(text);
  return INJECTION_PATTERNS.filter(([, pattern]) => pattern.test(value)).map(([flag]) => flag);
}

function cut(text: string, max: number): { text: string; truncated: boolean } {
  // Code points, so a cut never splits a surrogate pair.
  const chars = Array.from(text);
  if (chars.length <= max) return { text, truncated: false };
  return { text: `${chars.slice(0, max - 1).join('')}…`, truncated: true };
}

/**
 * Normalised, masked, defanged and truncated, wrapped as untrusted. Detection
 * runs on the text before HTML comments are removed, so an instruction hidden
 * in a comment is still flagged.
 */
export function untrusted(raw: string, max = MAX_TEXT_CHARS): UntrustedText {
  const flags = injectionFlags(raw);
  const cleaned = defangUrls(canonical(raw).replace(HTML_COMMENT, ''))
    .replace(/[ \t]+/g, ' ')
    .trim();
  const masked = maskPersonalData(cleaned) as string;
  const { text, truncated } = cut(masked, max);
  return {
    untrusted: true,
    text,
    ...(flags.length === 0 ? {} : { untrustedContentFlags: flags }),
    ...(truncated ? { truncated: true as const } : {}),
  };
}

/**
 * Text the model writes that a human will read before deciding (an
 * escalation note): canonical, no control characters, one line, so it can't
 * forge extra lines or terminal escapes on the approval screen.
 */
export function plainText(raw: string): string {
  return canonical(raw).replace(/\s+/g, ' ').trim();
}

/** Short upstream labels (account names, authors): cleaned and masked, not wrapped. */
export function label(raw: string, max = 120): string {
  return cut(maskPersonalData(defangUrls(canonical(raw).replace(HTML_COMMENT, ''))) as string, max)
    .text;
}

const MONEY =
  /[$€£₹¥]\s?\d|\b\d[\d,]*(\.\d+)?\s?(k|m|mm|bn)?\s?(usd|eur|gbp|inr|jpy|million|billion)\b|\b(usd|eur|gbp|inr)\s?\d|\barr\b/i;

/**
 * True when text written by the agent carries an email, a phone number or a
 * money amount: a basic guard against leaking data out through a comment.
 */
export function sensitiveContent(text: string): string[] {
  const found: string[] = [];
  const value = canonical(text);
  const masked = maskPersonalData(value) as string;
  if (masked.includes('[email]')) found.push('email');
  if (masked.includes('[phone]')) found.push('phone');
  if (MONEY.test(value)) found.push('money');
  return found;
}

/**
 * Keeps whole rows while the serialised result stays under the byte cap.
 * Rows are never cut mid-way; `truncated` says some were dropped.
 */
export function fitRows<Row, Out>(
  rows: Row[],
  build: (kept: Row[], truncated: boolean) => Out,
  maxBytes = MAX_RESPONSE_BYTES,
): Out {
  let kept = rows.slice(0, MAX_ROWS);
  let truncated = kept.length < rows.length;
  let out = build(kept, truncated);
  while (kept.length > 0 && Buffer.byteLength(JSON.stringify(out)) > maxBytes) {
    kept = kept.slice(0, -1);
    truncated = true;
    out = build(kept, truncated);
  }
  return out;
}

export type ToolErrorCode =
  | 'not_found'
  | 'insufficient_scope'
  | 'unauthorized'
  | 'validation_failed'
  | 'rate_limited'
  | 'upstream_unavailable'
  | 'invalid_state'
  | 'escalation_not_allowed'
  | 'sensitive_content'
  | 'session_limit';

export interface ToolError {
  isError: true;
  code: ToolErrorCode;
  retryable: boolean;
  retryAfterSeconds?: number;
  message: string;
}

const MESSAGES: Record<ToolErrorCode, [retryable: boolean, message: string]> = {
  not_found: [false, 'Nothing exists with that ID. Check the ID; do not guess another one.'],
  insufficient_scope: [
    false,
    'The user you act for is not allowed to do this. Tell the user; do not retry.',
  ],
  unauthorized: [false, 'The session is no longer authorised. Tell the user to restart it.'],
  validation_failed: [false, 'The arguments were not valid. Fix them as described and call again.'],
  rate_limited: [true, 'Too many calls. Wait retryAfterSeconds, then call again.'],
  upstream_unavailable: [
    true,
    'A source system is unavailable. Retry once later; if it still fails, tell the user.',
  ],
  invalid_state: [
    false,
    'The case cannot be escalated in its current state (closed, or already escalated). Do not retry.',
  ],
  escalation_not_allowed: [
    false,
    'Only P1 or P2 cases, or cases of any priority on platinum accounts, can be escalated. Do not retry.',
  ],
  sensitive_content: [
    false,
    'The text contains an email address, phone number or money amount. Remove it and call again.',
  ],
  session_limit: [
    false,
    'This session has used its tool-call budget. Stop calling tools and summarise for the user.',
  ],
};

export function toolError(
  code: ToolErrorCode,
  options: { detail?: string; retryAfterSeconds?: number } = {},
): ToolError {
  const [retryable, message] = MESSAGES[code];
  return {
    isError: true,
    code,
    retryable,
    ...(options.retryAfterSeconds === undefined
      ? {}
      : { retryAfterSeconds: options.retryAfterSeconds }),
    message: options.detail === undefined ? message : `${message} ${options.detail}`,
  };
}

const PROBLEM_CODES: Record<string, ToolErrorCode> = {
  'not-found': 'not_found',
  'insufficient-scope': 'insufficient_scope',
  unauthorized: 'unauthorized',
  'validation-failed': 'validation_failed',
  'invalid-cursor': 'validation_failed',
  'idempotency-key-reused': 'validation_failed',
  // A concurrent identical call is still running: retrying shortly is right.
  'request-in-progress': 'upstream_unavailable',
  'rate-limited': 'rate_limited',
  'invalid-state': 'invalid_state',
  'escalation-not-allowed': 'escalation_not_allowed',
};

/**
 * Maps an API problem to a tool error. Only the problem type and Retry-After
 * are used: upstream details never reach the model.
 */
export function fromProblem(problemType: string | undefined, retryAfter: string | null): ToolError {
  const slug = problemType?.split('/').pop() ?? '';
  const code = PROBLEM_CODES[slug] ?? 'upstream_unavailable';
  const seconds = retryAfter === null ? undefined : Number.parseInt(retryAfter, 10);
  return toolError(
    code,
    code === 'rate_limited' && seconds !== undefined && Number.isFinite(seconds)
      ? { retryAfterSeconds: seconds }
      : {},
  );
}
