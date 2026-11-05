import { expect, it } from "vite-plus/test";
import "~/index.css";
import { render } from "../../../test/render";
import { ComposerSurface } from "./ComposerSurface";

it.each([320, 360, 390])("keeps the lower controls inside the tab at %ipx", async (width) => {
  await using screen = await render(
    <div style={{ width }}>
      <ComposerSurface.Shell contextStrip>
        <ComposerSurface.Host>Composer</ComposerSurface.Host>
        <ComposerSurface.ContextStrip data-testid="strip">
          <button type="button">Environment</button>
          <button type="button" className="ml-auto">
            Branch
          </button>
        </ComposerSurface.ContextStrip>
      </ComposerSurface.Shell>
    </div>,
  );
  const strip = screen.getByTestId("strip").element();
  const shell = strip.parentElement!;
  const inset = 1.375 * Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  const shellRect = shell.getBoundingClientRect();
  const stripRect = strip.getBoundingClientRect();
  expect(stripRect.left).toBeGreaterThanOrEqual(shellRect.left + inset);
  expect(stripRect.right).toBeLessThanOrEqual(shellRect.right - inset);
});
