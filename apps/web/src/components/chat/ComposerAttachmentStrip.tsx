import type { ReactNode } from "react";

export function ComposerAttachmentStrip({ children }: { children: ReactNode }) {
  return (
    <div
      className="chat-composer-attachment-strip mb-3"
      role="group"
      aria-label="Attachments"
      tabIndex={0}
    >
      {children}
    </div>
  );
}
