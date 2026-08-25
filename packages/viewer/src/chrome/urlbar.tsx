/**
 * URL bar with back, forward, and reload controls.
 * (Gateway half P1-NAV-G = gateway/src/browser/nav.ts, browser domain. Split at the wire:
 * this component only sends `nav` Up msgs and renders `chrome` Down msgs.)
 */
import { useEffect, useState } from "preact/hooks";
import type { Down, TabId, Up } from "@mirror/protocol";

type ChromeState = Extract<Down, { t: "chrome" }>;
type NavAction = Extract<Up, { t: "nav" }>["action"];

export interface UrlBarProps {
  tab: TabId | null;
  chrome: ChromeState | null;
  send(message: Extract<Up, { t: "nav" }>): void;
}

export function UrlBar({ tab, chrome, send }: UrlBarProps) {
  const [value, setValue] = useState(chrome?.url ?? "");
  useEffect(() => setValue(chrome?.url ?? ""), [chrome?.url, tab]);
  const navigate = (action: NavAction, url?: string) => {
    if (tab === null) return;
    send(url === undefined ? { t: "nav", tab, action } : { t: "nav", tab, action, url });
  };

  return (
    <nav id="urlbar" aria-label="Browser navigation">
      <button
        type="button"
        aria-label="Back"
        disabled={tab === null || !chrome?.canBack}
        onClick={() => navigate("back")}
      >
        ←
      </button>
      <button
        type="button"
        aria-label="Forward"
        disabled={tab === null || !chrome?.canFwd}
        onClick={() => navigate("fwd")}
      >
        →
      </button>
      <button
        type="button"
        aria-label="Reload"
        disabled={tab === null}
        onClick={() => navigate("reload")}
      >
        ↻
      </button>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const url = normalizeNavigationUrl(value);
          if (url !== null) navigate("go", url);
        }}
      >
        <span
          className="loading-indicator"
          data-loading={chrome?.loading || undefined}
          aria-hidden="true"
        />
        <input
          aria-label="Address"
          type="text"
          value={value}
          disabled={tab === null}
          autoCapitalize="off"
          autoCorrect="off"
          spellcheck={false}
          onInput={(event) => setValue(event.currentTarget.value)}
        />
      </form>
    </nav>
  );
}

export function normalizeNavigationUrl(input: string): string | null {
  const value = input.trim();
  if (value === "") return null;
  return /^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`;
}
