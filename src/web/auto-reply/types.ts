import type { monitorWebInbox } from "../inbound.js";
import type { ReconnectPolicy } from "../reconnect.js";

export type WebInboundMsg = Parameters<typeof monitorWebInbox>[0]["onMessage"] extends (
  msg: infer M,
) => unknown
  ? M
  : never;

export type WebChannelStatus = {
  running: boolean;
  connected: boolean;
  reconnectAttempts: number;
  lastConnectedAt?: number | null;
  lastDisconnect?: {
    at: number;
    status?: number;
    error?: string;
    loggedOut?: boolean;
  } | null;
  lastMessageAt?: number | null;
  lastEventAt?: number | null;
  lastError?: string | null;
};

export type WebMonitorTuning = {
  reconnect?: Partial<ReconnectPolicy>;
  heartbeatSeconds?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  statusSink?: (status: WebChannelStatus) => void;
  /** WhatsApp account id. Default: "default". */
  accountId?: string;
  /** Debounce window (ms) for batching rapid consecutive messages from the same sender. */
  debounceMs?: number;
  /**
   * Optional tap called synchronously on each inbound message before the main handler.
   * Used by the ClawOS bridge to forward messages without a second Baileys session.
   * Errors thrown here must be caught by the caller; they must not propagate.
   *
   * Return `true` to signal that the message has been fully consumed by the sink
   * and should NOT be forwarded to the Claude agent handler.
   */
  messageSink?: (msg: WebInboundMsg) => boolean | void;
};
