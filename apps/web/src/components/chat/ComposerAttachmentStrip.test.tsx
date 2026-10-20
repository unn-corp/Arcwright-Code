// @effect-diagnostics nodeBuiltinImport:off - Check the shipped attachment layout rules.
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";
import { ComposerAttachmentStrip } from "./ComposerAttachmentStrip";

describe("ComposerAttachmentStrip", () => {
  it.each([375, 768, 1024, 1440])(
    "keeps mixed attachments in a sideways-scrolling row at %spx",
    (width) => {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      const style = document.createElement("style");
      const css = NodeFS.readFileSync(new NodeURL.URL("../../index.css", import.meta.url), "utf8");
      style.textContent = css.match(/\.chat-composer-attachment-strip[^}]*}/g)?.join("\n") ?? "";
      document.head.append(style);
      const host = document.createElement("div");
      host.style.width = `${width}px`;
      document.body.append(host);
      const root = createRoot(host);
      try {
        act(() =>
          root.render(
            <ComposerAttachmentStrip>
              {Array.from({ length: 30 }, (_, index) => (
                <button key={index} style={{ width: "64px" }}>
                  Attachment {index}
                </button>
              ))}
            </ComposerAttachmentStrip>,
          ),
        );
        const strip = host.querySelector<HTMLElement>("[aria-label='Attachments']")!;
        const layout = getComputedStyle(strip);
        expect(layout.display).toBe("flex");
        expect(layout.flexDirection).toBe("row");
        expect(layout.flexWrap).toBe("nowrap");
        expect(layout.overflowX).toBe("auto");
        expect(layout.minWidth).toBe("0px");
        expect(layout.maxWidth).toBe("100%");
        expect(strip.tabIndex).toBe(0);
        expect(strip.children).toHaveLength(30);
        for (const item of strip.children) expect(getComputedStyle(item).flexShrink).toBe("0");
      } finally {
        act(() => root.unmount());
        host.remove();
        style.remove();
        vi.unstubAllGlobals();
      }
    },
  );
});
