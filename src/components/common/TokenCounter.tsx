import {
    estimateTokens,
    currentSessionTokenCount,
    currentMessages,
    contextUsageFraction,
    activeModel,
    getContextWindow,
} from "../../stores/appStore";
import { TokenIcon } from "../icons";

interface TokenCounterProps {
    className?: string;
    showDetails?: boolean;
}

export function TokenCounter({ className = "", showDetails = false }: TokenCounterProps) {
    const totalTokens = currentSessionTokenCount.value;
    const windowTokens = getContextWindow(activeModel.value);
    const fraction = contextUsageFraction.value;
    const pct = Math.min(100, Math.round(fraction * 100));

    // Format large numbers
    const formatTokens = (n: number): string => {
        if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
        if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
        return n.toString();
    };

    // Color + level are driven by usage relative to the active model's window,
    // not absolute counts. The level word makes the state non-color-only.
    const level = fraction < 0.6 ? "ok" : fraction < 0.85 ? "high" : "very-high";
    const color = level === "ok" ? "text-success" : level === "high" ? "text-warning" : "text-error";
    const ariaText =
        `Context usage ${pct}% — ${formatTokens(totalTokens)} of ${formatTokens(windowTokens)} tokens` +
        (level === "ok" ? "" : level === "high" ? ", high usage" : ", very high usage — consider a new chat");

    if (!showDetails) {
        return (
            <div className={`flex items-center gap-1.5 ${className}`} title={ariaText} aria-label={ariaText}>
                <TokenIcon size={14} className={color} />
                <span className={`text-xs ${color}`}>
                    {pct}%
                </span>
            </div>
        );
    }

    // Calculate per-message stats
    const userTokens = currentMessages.value
        .filter(m => m.role === "user")
        .reduce((sum, m) => sum + estimateTokens(m.content), 0);

    const assistantTokens = currentMessages.value
        .filter(m => m.role === "assistant")
        .reduce((sum, m) => sum + estimateTokens(m.content), 0);

    return (
        <div className={`flex flex-col gap-1 ${className}`}>
            <div className="flex items-center gap-2">
                <TokenIcon size={16} className={color} />
                <span className={`text-sm font-medium ${color}`}>
                    {formatTokens(totalTokens)} / {formatTokens(windowTokens)} ({pct}%)
                </span>
            </div>
            <div className="flex items-center gap-4 text-xs text-text-tertiary">
                <span>You: {formatTokens(userTokens)}</span>
                <span>AI: {formatTokens(assistantTokens)}</span>
                <span>Messages: {currentMessages.value.length}</span>
            </div>
        </div>
    );
}

// Inline token badge for individual messages
interface MessageTokenBadgeProps {
    content: string;
}

export function MessageTokenBadge({ content }: MessageTokenBadgeProps) {
    const tokens = estimateTokens(content);

    if (tokens < 10) return null; // Don't show for very short messages

    return (
        <span
            className="text-xs text-text-tertiary/60 ml-2"
            title="Estimated tokens"
        >
            ~{tokens} tokens
        </span>
    );
}
