import { signal } from "@preact/signals";

export type ToastType = "success" | "error" | "info" | "warning";

export interface ToastAction {
    label: string;
    onClick: () => void;
}

export interface Toast {
    id: string;
    message: string;
    type: ToastType;
    duration?: number;
    action?: ToastAction;
}

// Toast queue
export const toasts = signal<Toast[]>([]);

// Cap the on-screen queue so a burst of errors can't stack endlessly.
const MAX_TOASTS = 4;

interface ShowToastOptions {
    duration?: number;
    action?: ToastAction;
}

// Show a toast notification. Identical (message+type) toasts are de-duped so a
// repeated failure doesn't stack N copies.
export function showToast(
    message: string,
    type: ToastType = "info",
    durationOrOpts: number | ShowToastOptions = 3000,
) {
    const opts: ShowToastOptions =
        typeof durationOrOpts === "number" ? { duration: durationOrOpts } : durationOrOpts;
    const duration = opts.duration ?? 3000;

    // De-dupe: if an identical toast is already showing, keep it (don't stack).
    const existing = toasts.value.find(t => t.message === message && t.type === type && !t.action);
    if (existing && !opts.action) return existing.id;

    const id = crypto.randomUUID();
    const toast: Toast = { id, message, type, duration, action: opts.action };

    const next = [...toasts.value, toast];
    // Drop the oldest if we exceed the cap.
    toasts.value = next.length > MAX_TOASTS ? next.slice(next.length - MAX_TOASTS) : next;

    // Auto-dismiss after duration
    if (duration > 0) {
        setTimeout(() => {
            dismissToast(id);
        }, duration);
    }

    return id;
}

// Dismiss a specific toast
export function dismissToast(id: string) {
    toasts.value = toasts.value.filter(t => t.id !== id);
}

// Clear all toasts
export function clearAllToasts() {
    toasts.value = [];
}

// Convenience methods
export const toast = {
    success: (message: string, duration?: number) => showToast(message, "success", duration),
    error: (message: string, duration?: number) => showToast(message, "error", duration),
    info: (message: string, duration?: number) => showToast(message, "info", duration),
    warning: (message: string, duration?: number) => showToast(message, "warning", duration),
    /** Toast with an action button (e.g. Undo). Longer default duration. */
    action: (message: string, action: ToastAction, type: ToastType = "info", duration = 6000) =>
        showToast(message, type, { action, duration }),
};
