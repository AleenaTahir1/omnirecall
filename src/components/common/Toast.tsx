import { toasts, dismissToast, ToastType } from "../../stores/toastStore";
import { CheckIcon, CloseIcon } from "../icons";

// Icons for toast types
function InfoIcon({ size = 16 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" />
            <path d="M8 7v4M8 5h.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
    );
}

function WarningIcon({ size = 16 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
            <path d="M8 1L15 14H1L8 1z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
            <path d="M8 6v3M8 11h.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
    );
}

function ErrorIcon({ size = 16 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" />
            <path d="M5 5l6 6M11 5l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
    );
}

function getToastStyles(type: ToastType) {
    switch (type) {
        case "success":
            return { border: "border-success/40", text: "text-success", icon: <CheckIcon size={16} /> };
        case "error":
            return { border: "border-error/40", text: "text-error", icon: <ErrorIcon size={16} /> };
        case "warning":
            return { border: "border-warning/40", text: "text-warning", icon: <WarningIcon size={16} /> };
        case "info":
        default:
            return { border: "border-accent-primary/40", text: "text-accent-primary", icon: <InfoIcon size={16} /> };
    }
}

export function ToastContainer() {
    if (toasts.value.length === 0) return null;

    return (
        <div
            className="fixed bottom-4 right-4 z-[9999] flex flex-col gap-2 pointer-events-none"
            role="status"
            aria-live="polite"
        >
            {toasts.value.map((toast) => {
                const styles = getToastStyles(toast.type);
                return (
                    <div
                        key={toast.id}
                        className={`pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-lg border shadow-lg animate-toast-in bg-bg-secondary ${styles.border}`}
                    >
                        <span className={styles.text}>{styles.icon}</span>
                        <span className="text-sm text-text-primary flex-1">{toast.message}</span>
                        {toast.action && (
                            <button
                                onClick={() => { toast.action!.onClick(); dismissToast(toast.id); }}
                                className={`px-2 py-1 rounded text-xs font-medium ${styles.text} hover:bg-bg-tertiary transition-colors`}
                            >
                                {toast.action.label}
                            </button>
                        )}
                        <button
                            onClick={() => dismissToast(toast.id)}
                            className="p-1 rounded hover:bg-bg-tertiary transition-colors text-text-tertiary hover:text-text-primary"
                            aria-label="Dismiss notification"
                        >
                            <CloseIcon size={12} />
                        </button>
                    </div>
                );
            })}
        </div>
    );
}
