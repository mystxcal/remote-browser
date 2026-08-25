/** Compact presence and driver controls outside the replay iframe. */
import type { PresenceEntry, Up } from "@mirror/protocol";

export interface PresenceProps {
  viewers: readonly PresenceEntry[];
  viewerId: string | null;
  driverId: string | null;
  send: (message: Up) => void;
}

export function Presence({ viewers, viewerId, driverId, send }: PresenceProps) {
  const isDriver = viewerId !== null && viewerId === driverId;
  return (
    <section
      id="presence-chrome"
      aria-label="Connected viewers"
      data-viewer-role={viewerId === null ? "pending" : isDriver ? "driver" : "follower"}
    >
      <ul>
        {viewers.map((viewer) => (
          <li
            key={viewer.id}
            data-viewer-id={viewer.id}
            data-driver={viewer.id === driverId ? "true" : "false"}
            title={viewer.id}
          >
            <span class="presence-name">
              {viewer.name}
              {viewer.id === viewerId ? " (you)" : ""}
            </span>
            {viewer.id === driverId && <span class="presence-driver">Driver</span>}
          </li>
        ))}
      </ul>
      {viewerId !== null && !isDriver && (
        <button
          type="button"
          class="request-driver"
          onClick={() => send({ t: "driver-transfer", to: viewerId })}
        >
          Request driver
        </button>
      )}
    </section>
  );
}
