// @effect-diagnostics globalDate:off
import * as NodeCrypto from "node:crypto";
import {
  EventId,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ThreadId,
} from "@t3tools/contracts";

export const message = (cause: unknown) =>
  cause instanceof Error && cause.message.trim() ? cause.message : String(cause);

export const now = () => new globalThis.Date().toISOString();

export const joinPath = (directory: string, filename: string) =>
  `${directory.replace(/[\\/]$/u, "")}/${filename}`;

export const rollbackTurns = <T>(turns: T[], numTurns: number): T[] | undefined => {
  if (!Number.isInteger(numTurns) || numTurns < 1 || numTurns > turns.length) return undefined;
  turns.splice(turns.length - numTurns, numTurns);
  return turns;
};

type WithoutEnvelope<E> = Omit<
  E,
  "eventId" | "provider" | "providerInstanceId" | "threadId" | "createdAt"
>;

/**
 * A runtime event minus the envelope fields an adapter always fills in itself.
 * Distributes over the event union so `type` and `payload` stay correlated at
 * the call site instead of degrading to `Record<string, unknown>`.
 */
export type ProviderRuntimeEventDraft = ProviderRuntimeEvent extends infer Event
  ? Event extends ProviderRuntimeEvent
    ? WithoutEnvelope<Event>
    : never
  : never;

export interface ProviderRuntimeEventEnvelope {
  readonly provider: ProviderDriverKind;
  readonly providerInstanceId: ProviderInstanceId;
  readonly threadId: ThreadId;
}

export const buildRuntimeEvent = (
  envelope: ProviderRuntimeEventEnvelope,
  draft: ProviderRuntimeEventDraft,
): ProviderRuntimeEvent =>
  ({
    eventId: EventId.make(NodeCrypto.randomUUID()),
    provider: envelope.provider,
    providerInstanceId: envelope.providerInstanceId,
    threadId: envelope.threadId,
    createdAt: now(),
    ...draft,
  }) as ProviderRuntimeEvent;
