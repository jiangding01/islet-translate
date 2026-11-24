import type { Engine } from '@/lib/config/types';
import { type AppError, appError } from '@/lib/errors';
import type { DetectedLanguages, LanguageCode } from '@/lib/languages';
import type { PortClient } from '@/lib/messaging/port';
import type {
  TranslateChunk,
  TranslateDisposition,
  TranslateDone,
  TranslateRequest,
} from '@/lib/messaging/protocol';
import { phoneticKey } from '@/lib/phonetic/word';

// The card's requests (plan 1.2 rules 4–7, 4.5 rule 2). One request at a time: a new one
// cancels the last. Every request gets the next number and remembers its `source`; a
// frame whose number is not the current one, or whose source is no longer the card's,
// is dropped. Only type imports from protocol.ts (the on-demand module may not create
// the messaging singleton); the Port client is injected.

/** Longer selections are never sent (plan 1.2 rule 5): no truncation, see the card's notice. */
export const MAX_SOURCE_LENGTH = 2000;

export type CardPort = PortClient<TranslateRequest, TranslateChunk, TranslateDone>;

export type RequestEvent =
  /** Waiting for the first words (also after a reset: the shown increments are gone). */
  | { kind: 'loading' }
  /** The streamed text so far. */
  | { kind: 'partial'; text: string }
  /** The final text, which replaces the increments; `text` is the source unless translated. */
  | { kind: 'done'; text: string; disposition: TranslateDisposition }
  | { kind: 'error'; error: AppError }
  | { kind: 'too-long' }
  /** The source word's British / American IPA (no slashes); `lemma`: the headword's readings. */
  | { kind: 'phonetic'; uk?: string; us?: string; lemma?: string };

export interface TranslateArgs {
  source: string;
  /** The card's one-off engine; absent means the configured one. */
  engine?: Engine;
  /** Menu or shortcut: the user asked, skip the same-language check. */
  force?: boolean;
  /** Another target than the configured one (the palette's reversed direction). */
  target?: LanguageCode;
  /** Ask for the word's phonetic too (see `wantsPhonetic`). */
  phonetic?: boolean;
}

/** The detected language's tag when the detection is reliable (the top language). */
export function reliableLanguage(result: DetectedLanguages | undefined): string | undefined {
  if (!result?.isReliable) return undefined;
  let top: { language: string; percentage: number } | undefined;
  for (const candidate of result.languages ?? []) {
    if (!top || candidate.percentage > top.percentage) top = candidate;
  }
  return top?.language;
}

const baseOf = (tag: string | undefined) => tag?.toLowerCase().split(/[-_]/)[0] ?? '';

/**
 * Pages in another Latin-script language: an unreliably detected word there may well be
 * theirs (French "chose"), not English. On any other page (Chinese, Japanese, …) a single
 * Latin word is all but always English.
 */
const LATIN_PAGES = new Set([
  'fr',
  'de',
  'es',
  'it',
  'pt',
  'nl',
  'sv',
  'da',
  'no',
  'nb',
  'fi',
  'pl',
  'cs',
  'tr',
  'id',
  'vi',
  'ro',
  'hu',
]);

/**
 * Whether the card asks for a phonetic: the source is a single English word (the
 * background's own rule), the target is not English, and the source may be English:
 * detected as English, or, when detection is unreliable or missing, not on a page that
 * declares another Latin-script language. `detected` is the reliable detection's language
 * tag, if any; `pageLanguage` is `<html lang>`. An unknown target (the menu opened the
 * card before the config was read) counts as not English. The background answers only
 * for words in its English tables.
 */
export function wantsPhonetic(args: {
  source: string;
  target: string | undefined;
  detected: string | undefined;
  pageLanguage: string | undefined;
}): boolean {
  if (baseOf(args.target) === 'en') return false;
  if (phoneticKey(args.source) === undefined) return false;
  if (args.detected !== undefined) return baseOf(args.detected) === 'en';
  return !LATIN_PAGES.has(baseOf(args.pageLanguage));
}

export interface CardRequests {
  /** Starts a request (cancelling the last); returns its number, 0 when nothing was sent. */
  translate(args: TranslateArgs, onEvent: (event: RequestEvent) => void): number;
  /** The number of the current request (0 before the first). */
  current(): number;
  cancel(): void;
  dispose(): void;
}

export interface CardRequestDeps {
  port: CardPort;
  /** The source the card shows now; frames for any other source are dropped. */
  currentSource(): string | undefined;
}

/** The extension was reloaded or updated: only a page reload reconnects. */
const pageUnreachable = () =>
  appError('network', 'network/page-unreachable', 'Extension context invalidated');

export function createCardRequests(deps: CardRequestDeps): CardRequests {
  let serial = 0;
  let live: { cancel(): void } | undefined;

  const cancel = () => {
    live?.cancel();
    live = undefined;
  };

  return {
    translate(args, onEvent) {
      cancel();
      const id = ++serial;
      const { source } = args;
      if (source.length > MAX_SOURCE_LENGTH) {
        onEvent({ kind: 'too-long' });
        return 0;
      }
      /** Still the card's request: same number, same source. */
      const current = () => id === serial && deps.currentSource() === source;
      const payload: TranslateRequest = {
        items: [{ id: 's', text: source }],
        source: 'auto',
        stream: true,
      };
      if (args.engine) payload.engine = args.engine;
      if (args.force) payload.force = true;
      if (args.target) payload.target = args.target;
      if (args.phonetic) payload.phonetic = true;
      let text = '';
      let finished = false;
      let retried = false;

      const onChunk = (chunk: TranslateChunk) => {
        if (!current()) return;
        if ('phonetic' in chunk) {
          // Not a result: it may come after the final chunk, until the request ends.
          const { uk, us } = chunk.phonetic;
          onEvent({ kind: 'phonetic', uk, us, lemma: chunk.lemma });
          return;
        }
        if (finished) return;
        if ('reset' in chunk) {
          // A new attempt: whatever streamed so far is void (plan 1.2 rule 6).
          text = '';
          onEvent({ kind: 'loading' });
        } else if ('delta' in chunk) {
          text += chunk.delta;
          onEvent({ kind: 'partial', text });
        } else if ('error' in chunk) {
          finished = true;
          onEvent({ kind: 'error', error: chunk.error });
        } else {
          finished = true;
          // The final text replaces the increments (it is cleaned, they were not).
          onEvent({ kind: 'done', text: chunk.text, disposition: chunk.disposition });
        }
      };

      const send = () => {
        const request = deps.port.request(payload, onChunk);
        live = request;
        void request.outcome.then((outcome) => {
          if (live === request) live = undefined;
          if (finished || !current() || outcome.status === 'cancelled') return;
          if (outcome.status === 'done') {
            // Done without a final chunk: nothing to show, which is a failure.
            finished = true;
            onEvent({
              kind: 'error',
              error: appError('validation', 'validation/bad-response', 'No final chunk'),
            });
            return;
          }
          const { error } = outcome;
          if (error.code === 'network/port-disconnected' && !retried) {
            // The service worker restarted: reconnect and try once more, from scratch.
            retried = true;
            text = '';
            onEvent({ kind: 'loading' });
            send();
            return;
          }
          finished = true;
          onEvent({
            kind: 'error',
            error: error.code === 'internal/context-invalidated' ? pageUnreachable() : error,
          });
        });
      };

      onEvent({ kind: 'loading' });
      send();
      return id;
    },
    current: () => serial,
    cancel() {
      // Bumping the number also drops anything already on its way.
      serial += 1;
      cancel();
    },
    dispose() {
      serial += 1;
      cancel();
      deps.port.dispose();
    },
  };
}
