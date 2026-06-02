import { useEffect } from "preact/hooks";
import { RefObject } from "preact";

/// Trap keyboard focus inside a modal/overlay for accessibility:
///   - moves focus to the first focusable element on open
///   - cycles Tab / Shift+Tab within the container instead of escaping to the
///     page behind the overlay
///   - restores focus to the element that was focused before opening
///   - optionally closes on Escape (and stops the event so a global Escape
///     handler doesn't also fire, e.g. hiding the whole window)
///
/// Extracted from the proven Settings modal implementation so every overlay
/// (CommandPalette, ModelCompare, ExportImport, KeyboardShortcuts, Onboarding)
/// behaves consistently.
export function useFocusTrap<T extends HTMLElement>(
  ref: RefObject<T>,
  active: boolean,
  onClose?: () => void,
) {
  useEffect(() => {
    if (!active) return;
    const container = ref.current;
    if (!container) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    const getFocusable = (): HTMLElement[] => {
      const els = Array.from(
        container.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      // Skip elements that are hidden (display:none collapses offsetParent) or
      // explicitly hidden from the a11y tree.
      return els.filter(
        (el) => el.offsetParent !== null && el.getAttribute("aria-hidden") !== "true",
      );
    };

    const focusables = getFocusable();
    if (focusables.length > 0) focusables[0].focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && onClose) {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const els = getFocusable();
      if (els.length === 0) return;
      const first = els[0];
      const last = els[els.length - 1];
      const activeEl = document.activeElement as HTMLElement;
      if (e.shiftKey) {
        if (activeEl === first || !container.contains(activeEl)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (activeEl === last || !container.contains(activeEl)) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    container.addEventListener("keydown", handleKeyDown);
    return () => {
      container.removeEventListener("keydown", handleKeyDown);
      // Restore focus to where the user was before the modal opened.
      previouslyFocused?.focus?.();
    };
  }, [active, onClose, ref]);
}
