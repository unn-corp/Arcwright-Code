import { type PreviewAnnotationPayload, type ThreadId } from "@t3tools/contracts";
import type { PickedElementPayload, PickedElementStackFrame } from "@t3tools/contracts";

const ELEMENT_CONTEXT_HTML_PREVIEW_LIMIT = 4000;
const ELEMENT_CONTEXT_STYLES_LIMIT = 4000;
const ELEMENT_CONTEXT_LABEL_TAG_MAX = 24;

export interface ElementContextSelection {
  pageUrl: string;
  pageTitle: string | null;
  tagName: string;
  selector: string | null;
  htmlPreview: string;
  componentName: string | null;
  source: PickedElementStackFrame | null;
  styles: string;
}

export interface ElementContextDraft extends ElementContextSelection {
  /** Stable composer-side id used for keyed rendering + dedupe. */
  id: string;
  threadId: ThreadId;
  /** ISO-8601 wall clock pick time. */
  pickedAt: string;
}

function truncateString(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
}

/**
 * Trims/clamps every string field so we never persist a 5MB outerHTML blob and
 * silently break `localStorage`.
 */
export function normalizeElementContextSelection(
  raw: PickedElementPayload,
): ElementContextSelection | null {
  const pageUrl = raw.pageUrl.trim();
  const tagName = raw.tagName.trim().toLowerCase();
  if (pageUrl.length === 0 || tagName.length === 0) {
    return null;
  }
  const stackFrame = raw.source ?? raw.stack[0] ?? null;
  return {
    pageUrl,
    pageTitle: raw.pageTitle?.trim() ?? null,
    tagName,
    selector: raw.selector?.trim() || null,
    htmlPreview: truncateString(normalizeText(raw.htmlPreview), ELEMENT_CONTEXT_HTML_PREVIEW_LIMIT),
    componentName: raw.componentName?.trim() || null,
    source: stackFrame
      ? {
          functionName: stackFrame.functionName?.trim() || null,
          fileName: stackFrame.fileName?.trim() || null,
          lineNumber: stackFrame.lineNumber ?? null,
          columnNumber: stackFrame.columnNumber ?? null,
        }
      : null,
    styles: truncateString(normalizeText(raw.styles), ELEMENT_CONTEXT_STYLES_LIMIT),
  };
}

export function elementContextToPreviewAnnotation(
  element: ElementContextSelection,
  id: string,
  pickedAt: string,
): PreviewAnnotationPayload {
  return {
    id,
    pageUrl: element.pageUrl,
    pageTitle: element.pageTitle,
    comment: "",
    elements: [
      {
        id,
        element: { ...element, stack: [], pickedAt },
        rect: { x: 0, y: 0, width: 0, height: 0 },
      },
    ],
    regions: [],
    strokes: [],
    styleChanges: [],
    screenshot: null,
    createdAt: pickedAt,
  };
}

function shortenTagLabel(tagName: string): string {
  if (tagName.length <= ELEMENT_CONTEXT_LABEL_TAG_MAX) return tagName;
  return `${tagName.slice(0, ELEMENT_CONTEXT_LABEL_TAG_MAX - 1)}…`;
}

/**
 * Compact chip label — `<Button>` for component picks, `<button>` otherwise.
 * Component name takes priority because it's higher-signal for the agent.
 */
export function formatElementContextLabel(context: ElementContextSelection): string {
  if (context.componentName) return `<${context.componentName}>`;
  return `<${shortenTagLabel(context.tagName)}>`;
}
