import { useCallback } from "preact/hooks";

export function useAutoResize(maxHeight = 200) {
  // Imperative resize so programmatic value changes (quick-start prompts, the
  // post-submit clear, retry) keep the textarea height correct — not just
  // onInput.
  const resize = useCallback((textarea: HTMLTextAreaElement | null) => {
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
  }, [maxHeight]);

  const handleAutoResize = useCallback((e: Event) => {
    resize(e.target as HTMLTextAreaElement);
  }, [resize]);

  return { handleAutoResize, resize };
}
