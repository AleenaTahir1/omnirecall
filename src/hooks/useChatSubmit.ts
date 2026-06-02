import { useRef, useCallback } from "preact/hooks";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import {
  activeModel,
  activeProvider,
  providers,
  isGenerating,
  currentQuery,
  activeSessionId,
  activeBranchId,
  currentMessages,
  addChatSession,
  updateChatSession,
  updateBranchMessages,
  saveChatHistoryNow,
  branchFromMessage,
  startNewChat,
  getSemanticContext,
  isOnline,
  ChatMessage,
  ChatSession,
  estimateTokens,
  systemPrompt,
  setSystemPrompt,
  stopGeneration,
  isShortcutsHelpOpen,
} from "../stores/appStore";

/// If we don't see a stream chunk for this long, assume the connection is
/// dead and surface an error rather than leaving the user staring at a
/// blinking cursor forever.
const CHUNK_IDLE_TIMEOUT_MS = 60_000;

/// Below this combined document size we just send the full text; above it we
/// switch to semantic retrieval (top-k relevant chunks) so large corpora don't
/// blow the model's context window.
const FULL_DOC_CONTEXT_THRESHOLD = 12_000;

interface DocumentWithContent {
  name: string;
  content?: string;
}

/// Hard cap on a single user message. The actual model context window is
/// far smaller than this, but we use the cap as a frontline guard against
/// pasted megabytes of text (which would freeze the textarea). The error
/// message points the user toward the document feature for large content.
export const MAX_MESSAGE_CHARS = 200_000;

/// Handle a slash command typed into the input. Returns true if the
/// input was consumed (the caller should clear the input and skip the
/// model send). Returns false if the command was unrecognized — in that
/// case we let the message go through so the model can answer about it.
///
/// Supported:
///   /clear            - drop the current conversation (no save)
///   /new              - start a fresh chat
///   /help             - open the keyboard shortcuts overlay
///   /system <prompt>  - replace the persistent system prompt
function handleSlashCommand(input: string, setError: (e: string | null) => void): boolean {
  const space = input.indexOf(" ");
  const cmd = (space === -1 ? input : input.slice(0, space)).toLowerCase();
  const arg = space === -1 ? "" : input.slice(space + 1).trim();

  switch (cmd) {
    case "/clear":
    case "/new": {
      startNewChat();
      setError(null);
      return true;
    }
    case "/help": {
      isShortcutsHelpOpen.value = true;
      return true;
    }
    case "/system": {
      if (!arg) {
        setError("Usage: /system <your system prompt>");
        return true;
      }
      setSystemPrompt(arg);
      return true;
    }
    default:
      return false;
  }
}

// Parse and simplify API error messages for user display
export function parseApiError(err: any): string {
  const rawMessage = err?.message || err?.toString() || "Failed to get response";

  // Rate limit / quota errors
  if (rawMessage.includes("429") || rawMessage.includes("quota") || rawMessage.includes("RESOURCE_EXHAUSTED")) {
    return "Rate limit exceeded. Please wait a moment and try again.";
  }

  // Authentication errors
  if (rawMessage.includes("401") || rawMessage.includes("unauthorized") || rawMessage.includes("invalid_api_key")) {
    return "Invalid API key. Please check your settings.";
  }

  // Model not found
  if (rawMessage.includes("404") || rawMessage.includes("model not found")) {
    return "Model not found. Please select a different model.";
  }

  // Context too long
  if (rawMessage.includes("context_length") || rawMessage.includes("too long") || rawMessage.includes("max tokens")) {
    return "Message too long. Try shortening your input or clearing some context.";
  }

  // Network/connection errors
  if (rawMessage.includes("network") || rawMessage.includes("ECONNREFUSED") || rawMessage.includes("timeout")) {
    return "Connection failed. Check your internet connection.";
  }

  // If message is super long, truncate it
  if (rawMessage.length > 150) {
    const match = rawMessage.match(/message["']?\s*[:=]\s*["']([^"']+)["']/i);
    if (match) return match[1].slice(0, 100);
    return rawMessage.slice(0, 100) + "...";
  }

  return rawMessage;
}

/// Build the document context payload for a query. For small corpora we send
/// the full text; for large ones we ask the backend vector store for the most
/// relevant chunks so we don't overflow the context window. Falls back to full
/// content if semantic retrieval returns nothing (e.g. nothing indexed yet).
async function buildDocumentContext(
  docsWithContent: DocumentWithContent[],
  query: string,
): Promise<{ name: string; content: string }[]> {
  const withContent = docsWithContent.filter(d => d.content && d.content.length > 0);
  if (withContent.length === 0) return [];

  const totalChars = withContent.reduce((sum, d) => sum + (d.content?.length ?? 0), 0);
  if (totalChars <= FULL_DOC_CONTEXT_THRESHOLD) {
    return withContent.map(d => ({ name: d.name, content: d.content! }));
  }

  // Large corpus: prefer semantic retrieval.
  try {
    const semantic = await getSemanticContext(query);
    if (semantic && semantic.trim().length > 0) {
      return [{ name: "Relevant document excerpts", content: semantic }];
    }
  } catch {
    // fall through to full content
  }
  return withContent.map(d => ({ name: d.name, content: d.content! }));
}

/// Captured context for the last send, so the error banner can offer a
/// one-click "Try again" without the user re-typing their message.
interface LastSend {
  kind: "submit" | "regenerate";
  message: string;
  assistantMessageId?: string;
}

export function useChatSubmit(
  docsWithContent: DocumentWithContent[],
  setError: (err: string | null) => void,
) {
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const streamingContentRef = useRef("");
  const throttleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSendRef = useRef<LastSend | null>(null);

  // Clean up stream listener
  const cleanupStream = useCallback(() => {
    if (unlistenRef.current) {
      unlistenRef.current();
      unlistenRef.current = null;
    }
    if (throttleTimerRef.current) {
      clearTimeout(throttleTimerRef.current);
      throttleTimerRef.current = null;
    }
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
    streamingContentRef.current = "";
  }, []);

  /// Shared streaming core used by both the initial send and regenerate.
  /// Handles the listener, 80ms throttle, idle watchdog, race-safe flush, and
  /// final token count. Persistence differs per caller, so it is delegated to
  /// the onComplete callback (which receives the final content and whether the
  /// user is still looking at the originating thread).
  const runAssistantStream = useCallback(
    async (params: {
      assistantId: string;
      submitSessionId: string | null;
      submitBranchId: string | null;
      message: string;
      history: { role: string; content: string }[];
      documents: { name: string; content: string }[];
      apiKey: string;
      provider?: string;
      model?: string;
      onComplete: (finalContent: string, sameThread: boolean) => void;
    }) => {
      const { assistantId, submitSessionId, submitBranchId, message, history, documents, apiKey, onComplete } = params;
      streamingContentRef.current = "";

      const stillOnSameThread = () =>
        activeSessionId.value === submitSessionId && activeBranchId.value === submitBranchId;
      const findAssistantIndex = (msgs: ChatMessage[]) => msgs.findIndex(m => m.id === assistantId);

      const flushStreamUpdate = () => {
        if (!stillOnSameThread()) return;
        const msgs = currentMessages.value;
        const idx = findAssistantIndex(msgs);
        if (idx === -1) return;
        const next = [...msgs];
        next[idx] = { ...next[idx], content: streamingContentRef.current };
        currentMessages.value = next;
      };

      const armIdleTimer = () => {
        if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
        idleTimerRef.current = setTimeout(() => {
          stopGeneration();
          cleanupStream();
          isGenerating.value = false;
          setError("Connection stalled. The AI provider stopped responding. Please try again.");
        }, CHUNK_IDLE_TIMEOUT_MS);
      };

      armIdleTimer();

      unlistenRef.current = await listen<{ chunk: string; done: boolean }>("chat-stream", (event) => {
        if (!event.payload.done) {
          streamingContentRef.current += event.payload.chunk;
          armIdleTimer();
          if (!throttleTimerRef.current) {
            throttleTimerRef.current = setTimeout(() => {
              throttleTimerRef.current = null;
              flushStreamUpdate();
            }, 80);
          }
        } else {
          if (throttleTimerRef.current) {
            clearTimeout(throttleTimerRef.current);
            throttleTimerRef.current = null;
          }
          if (idleTimerRef.current) {
            clearTimeout(idleTimerRef.current);
            idleTimerRef.current = null;
          }

          const finalContent = streamingContentRef.current;
          const sameThread = stillOnSameThread();

          if (sameThread) {
            const msgs = currentMessages.value;
            const idx = findAssistantIndex(msgs);
            if (idx !== -1) {
              const next = [...msgs];
              next[idx] = {
                ...next[idx],
                content: finalContent,
                tokenCount: estimateTokens(finalContent),
              };
              currentMessages.value = next;
            }
          }

          isGenerating.value = false;
          cleanupStream();
          onComplete(finalContent, sameThread);
        }
      });

      try {
        await invoke("send_message_stream", {
          message,
          history,
          documents,
          provider: params.provider ?? activeProvider.value,
          model: params.model ?? activeModel.value,
          apiKey,
          systemPrompt: systemPrompt.value.trim() || null,
        });
      } catch (err: any) {
        setError(parseApiError(err));
        isGenerating.value = false;
        cleanupStream();
      }
    },
    [cleanupStream, setError],
  );

  const handleSubmit = useCallback(async () => {
    if (!currentQuery.value.trim() || isGenerating.value) return;

    // Slash commands. Handled before any provider/network checks so power
    // users can /clear or /help even with no API key configured.
    const trimmed = currentQuery.value.trim();
    if (trimmed.startsWith("/")) {
      if (handleSlashCommand(trimmed, setError)) {
        currentQuery.value = "";
        return;
      }
    }

    if (currentQuery.value.length > MAX_MESSAGE_CHARS) {
      setError(
        `Message is too long (${currentQuery.value.length.toLocaleString()} characters). ` +
        `Maximum is ${MAX_MESSAGE_CHARS.toLocaleString()}. ` +
        `For larger content, add it as a document instead.`,
      );
      return;
    }

    const provider = providers.value.find(p => p.id === activeProvider.value);
    if (!provider?.apiKey && provider?.id !== "ollama") {
      setError(
        `No API key for ${provider?.name ?? activeProvider.value}. Open Settings (Ctrl+,) to add one.`,
      );
      return;
    }

    // Cloud providers need connectivity; local Ollama doesn't.
    if (!isOnline.value && provider?.id !== "ollama") {
      setError("You're offline. Reconnect, or switch to a local Ollama model.");
      return;
    }

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: currentQuery.value,
      tokenCount: estimateTokens(currentQuery.value),
    };

    const newMessages = [...currentMessages.value, userMessage];
    currentMessages.value = newMessages;
    const query = currentQuery.value;
    currentQuery.value = "";
    isGenerating.value = true;
    setError(null);
    lastSendRef.current = { kind: "submit", message: query };

    // Create placeholder for assistant message
    const assistantId = crypto.randomUUID();
    const assistantMessage: ChatMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
      tokenCount: 0,
    };
    currentMessages.value = [...newMessages, assistantMessage];

    // Capture the session/branch context at submit time. If the user
    // navigates away mid-stream we don't mutate whatever they're now looking at.
    const submitSessionId = activeSessionId.value;
    const submitBranchId = activeBranchId.value;

    const history = newMessages.slice(0, -1).map(m => ({ role: m.role, content: m.content }));
    const documents = await buildDocumentContext(docsWithContent, query);

    await runAssistantStream({
      assistantId,
      submitSessionId,
      submitBranchId,
      message: query,
      history,
      documents,
      apiKey: provider?.apiKey || "",
      onComplete: (finalContent, sameThread) => {
        if (!submitSessionId) {
          // First message in a fresh chat: only create a session if we
          // actually have content. Empty stream completions (network failure,
          // provider returns nothing) shouldn't litter the sidebar.
          if (finalContent.trim().length > 0) {
            const messagesToSave = sameThread
              ? currentMessages.value
              : [
                  ...newMessages,
                  { ...assistantMessage, content: finalContent, tokenCount: estimateTokens(finalContent) },
                ];
            const newSession: ChatSession = {
              id: crypto.randomUUID(),
              title: userMessage.content.slice(0, 30) + (userMessage.content.length > 30 ? "..." : ""),
              messages: messagesToSave,
              branches: [],
              branchMessages: {},
              createdAt: new Date().toISOString(),
              folderId: null,
            };
            addChatSession(newSession);
            if (sameThread) {
              activeSessionId.value = newSession.id;
            }
          }
        } else if (sameThread) {
          if (submitBranchId) {
            updateBranchMessages(submitSessionId, submitBranchId, currentMessages.value);
          } else {
            updateChatSession(submitSessionId, currentMessages.value);
          }
          saveChatHistoryNow();
        } else if (finalContent.trim().length > 0) {
          // User navigated away from an existing session mid-stream. Persist
          // the reconstructed thread to the captured session/branch so the
          // answer isn't lost — they may come back to it.
          const finalMessages = [
            ...newMessages,
            { ...assistantMessage, content: finalContent, tokenCount: estimateTokens(finalContent) },
          ];
          if (submitBranchId) {
            updateBranchMessages(submitSessionId, submitBranchId, finalMessages);
          } else {
            updateChatSession(submitSessionId, finalMessages);
          }
          saveChatHistoryNow();
        }
      },
    });
  }, [docsWithContent, setError, runAssistantStream]);

  /// Regenerate an assistant reply. Creates a branch from the preceding user
  /// message, then streams a fresh answer into it. Optionally overrides the
  /// provider/model so the user can retry on a different model.
  const regenerate = useCallback(
    async (assistantMessageId: string, overrideProvider?: string, overrideModel?: string) => {
      if (!activeSessionId.value || isGenerating.value) return;

      const msgs = currentMessages.value;
      const msgIndex = msgs.findIndex(m => m.id === assistantMessageId);
      if (msgIndex <= 0) return;

      const userMessage = msgs[msgIndex - 1];
      if (userMessage.role !== "user") return;

      const providerId = overrideProvider || activeProvider.value;
      const provider = providers.value.find(p => p.id === providerId);
      if (!provider?.apiKey && provider?.id !== "ollama") {
        setError(`No API key for ${provider?.name ?? providerId}. Open Settings (Ctrl+,) to add one.`);
        return;
      }

      const sessionId = activeSessionId.value;
      // branchFromMessage sets currentMessages to the branched copy (up to and
      // including the user message) and activeBranchId to the new branch.
      const branchId = branchFromMessage(sessionId, userMessage.id);
      if (!branchId) return;

      isGenerating.value = true;
      setError(null);

      const assistantId = crypto.randomUUID();
      const assistantMessage: ChatMessage = {
        id: assistantId,
        role: "assistant",
        content: "",
        tokenCount: 0,
      };
      const baseMessages = [...currentMessages.value, assistantMessage];
      currentMessages.value = baseMessages;
      lastSendRef.current = { kind: "regenerate", message: userMessage.content, assistantMessageId };

      const submitSessionId = sessionId;
      const submitBranchId = branchId;

      // History = everything before the user message (exclude the user message
      // itself and the just-added empty placeholder).
      const history = baseMessages.slice(0, -2).map(m => ({ role: m.role, content: m.content }));
      const documents = await buildDocumentContext(docsWithContent, userMessage.content);

      await runAssistantStream({
        assistantId,
        submitSessionId,
        submitBranchId,
        message: userMessage.content,
        history,
        documents,
        apiKey: provider?.apiKey || "",
        provider: providerId,
        model: overrideModel || activeModel.value,
        onComplete: (finalContent, sameThread) => {
          if (finalContent.trim().length > 0) {
            // Fix for the old data-loss bug: when the user has navigated away,
            // persist the reconstructed branch messages instead of writing [].
            const finalMessages = sameThread
              ? currentMessages.value
              : [
                  ...baseMessages.slice(0, -1),
                  { ...assistantMessage, content: finalContent, tokenCount: estimateTokens(finalContent) },
                ];
            updateBranchMessages(submitSessionId, submitBranchId, finalMessages);
            saveChatHistoryNow();
          }
        },
      });
    },
    [docsWithContent, setError, runAssistantStream],
  );

  /// Retry the last send after a failure. Re-runs the most recent submit
  /// (re-using the captured user message) or regenerate, without the user
  /// having to retype anything.
  const retryLast = useCallback(async () => {
    const last = lastSendRef.current;
    if (!last || isGenerating.value) return;
    setError(null);
    if (last.kind === "regenerate" && last.assistantMessageId) {
      await regenerate(last.assistantMessageId);
      return;
    }
    // Re-submit: drop any empty/failed trailing assistant placeholder, then
    // re-send the captured user message.
    const msgs = currentMessages.value;
    const trimmed = msgs[msgs.length - 1]?.role === "assistant" && !msgs[msgs.length - 1].content
      ? msgs.slice(0, -1)
      : msgs;
    // Remove the trailing user message too (handleSubmit re-adds it from currentQuery).
    const withoutUser = trimmed[trimmed.length - 1]?.role === "user" ? trimmed.slice(0, -1) : trimmed;
    currentMessages.value = withoutUser;
    currentQuery.value = last.message;
    await handleSubmit();
  }, [regenerate, handleSubmit, setError]);

  return { handleSubmit, regenerate, retryLast, cleanupStream };
}
