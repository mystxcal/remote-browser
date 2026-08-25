/** A user-gesture clipboard bridge outside the replay iframe. */

export interface ClipboardPromptProps {
  text: string | null;
  error?: string | null;
  writeText?: (text: string) => Promise<void>;
  onCopied: () => void;
  onCopyError?: (error: unknown) => void;
}

function writeLocalClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText === undefined) {
    return Promise.reject(new Error("Clipboard access is unavailable"));
  }
  return navigator.clipboard.writeText(text);
}

export function ClipboardPrompt({
  text,
  error = null,
  writeText = writeLocalClipboard,
  onCopied,
  onCopyError,
}: ClipboardPromptProps) {
  return (
    <aside
      id="clipboard-prompt-layer"
      aria-label="Remote clipboard"
      aria-hidden={text === null ? "true" : undefined}
    >
      {text !== null && (
        <section class="clipboard-prompt">
          <span>The remote page copied text.</span>
          <button
            type="button"
            onClick={async () => {
              try {
                await writeText(text);
                onCopied();
              } catch (copyError) {
                onCopyError?.(copyError);
              }
            }}
          >
            Copy to my clipboard
          </button>
          {error !== null && (
            <span class="clipboard-error" role="alert">
              {error}
            </span>
          )}
        </section>
      )}
    </aside>
  );
}
