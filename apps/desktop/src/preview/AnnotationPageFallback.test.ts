import { afterEach, expect, it, vi } from "vite-plus/test";
import { ANNOTATION_PAGE_FALLBACK_SCRIPT } from "./AnnotationPageFallback.ts";
import { DesktopPreviewAnnotationPageSchema } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
const decodePage = Schema.decodeUnknownSync(DesktopPreviewAnnotationPageSchema);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});
it("captures structured DOM context without a picker preload or React lookup", () => {
  document.title = "Clarity Relay";
  document.body.innerHTML =
    '<button id="target">Annotate me</button><button hidden>Hidden</button><div data-t3code-annotation-ui="true"><button>Editor</button></div>';
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    left: 10,
    top: 20,
    right: 110,
    bottom: 60,
    x: 10,
    y: 20,
    width: 100,
    height: 40,
    toJSON: () => ({}),
  });
  vi.stubGlobal("CSS", { escape: (id: string) => id });
  const page = decodePage(window.eval(ANNOTATION_PAGE_FALLBACK_SCRIPT));
  expect(page.pageTitle).toBe("Clarity Relay");
  expect(page.elements).toHaveLength(1);
  expect(page.elements[0]?.element.htmlPreview).toContain("Annotate me");
  expect(page.elements[0]?.element.selector).toBe("#target");
  document.querySelector("#target")!.textContent = "Changed";
  expect(page.elements[0]?.element.htmlPreview).toContain("Annotate me");
});
it("bounds a large document to 256 captured targets", () => {
  document.body.innerHTML = "<button>Target</button>".repeat(500);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    right: 10,
    bottom: 10,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    toJSON: () => ({}),
  });
  vi.spyOn(performance, "now").mockReturnValue(0);
  expect(decodePage(window.eval(ANNOTATION_PAGE_FALLBACK_SCRIPT)).elements).toHaveLength(256);
});
