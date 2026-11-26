import type { ConfigRepository } from '@/lib/config/repository';
import type { ConfigChange, ConfigPath, ConfigSnapshot } from '@/lib/config/types';
import { type AppError, appError, type Result } from '@/lib/errors';
import type { GlossaryRepository } from '@/lib/glossary/repository';
import type { GlossaryChange, GlossaryEntry } from '@/lib/glossary/types';
import { handle } from './handle';

export interface MessageSenderLike {
  url?: string;
}

export function forbiddenSenderError(): AppError {
  return appError('validation', 'validation/forbidden-sender', 'Sender is not allowed');
}

/**
 * True only for pages of this extension (popup, options): `extensionRoot` is
 * `browser.runtime.getURL('/')`. Content scripts report the web page's URL.
 */
export function isExtensionPageSender(
  sender: MessageSenderLike | undefined,
  extensionRoot: string,
): boolean {
  const url = sender?.url;
  return typeof url === 'string' && url.startsWith(extensionRoot);
}

export interface ConfigHandlerDeps {
  repo: Pick<ConfigRepository, 'patch' | 'reset'>;
  extensionRoot: string;
}

/** `config.patch` / `config.reset` handlers, restricted to extension pages. */
export function createConfigHandlers(deps: ConfigHandlerDeps) {
  const guard = (sender: MessageSenderLike | undefined) => {
    if (!isExtensionPageSender(sender, deps.extensionRoot)) throw forbiddenSenderError();
  };
  return {
    'config.patch': (
      sender: MessageSenderLike | undefined,
      changes: ConfigChange[],
    ): Promise<Result<ConfigSnapshot>> =>
      handle(() => {
        guard(sender);
        return deps.repo.patch(changes);
      })(),
    'config.reset': (
      sender: MessageSenderLike | undefined,
      paths: ConfigPath[] | undefined,
    ): Promise<Result<ConfigSnapshot>> =>
      handle(() => {
        guard(sender);
        return deps.repo.reset(paths);
      })(),
  };
}

export interface GlossaryHandlerDeps {
  repo: Pick<GlossaryRepository, 'change'>;
  extensionRoot: string;
}

/** The `glossary.change` handler (M4-C), restricted to extension pages like config writes. */
export function createGlossaryHandlers(deps: GlossaryHandlerDeps) {
  return {
    'glossary.change': (
      sender: MessageSenderLike | undefined,
      change: GlossaryChange,
    ): Promise<Result<GlossaryEntry[]>> =>
      handle(() => {
        if (!isExtensionPageSender(sender, deps.extensionRoot)) throw forbiddenSenderError();
        return deps.repo.change(change);
      })(),
  };
}
