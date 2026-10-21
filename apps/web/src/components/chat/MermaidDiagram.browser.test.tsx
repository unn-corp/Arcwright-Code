import { Suspense } from "react";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import "../../index.css";
import { MermaidDiagram } from "./MermaidDiagram";

it("renders and expands a real diagram without fetching author-supplied style URLs", async () => {
  const onExpand = vi.fn<(url: string) => void>();
  await using screen = await render(
    <Suspense fallback={<p>Loading diagram</p>}>
      <MermaidDiagram
        source={
          "%%{init: {'themeVariables': {'primaryColor': 'url(/__diagram_style_probe__)'}}}%%\nflowchart LR\nA[Start] --> B[Finish]"
        }
        onExpand={onExpand}
      />
    </Suspense>,
  );
  await expect.element(screen.getByRole("button", { name: "Expand diagram" })).toBeVisible();
  await vi.waitFor(() => {
    const svg = screen.container.querySelector("svg");
    expect(svg?.textContent).toContain("Start");
    expect(svg?.textContent).toContain("Finish");
    expect(svg?.outerHTML).not.toContain("__diagram_style_probe__");
  });
  await screen.getByRole("button", { name: "Expand diagram" }).click();
  expect(onExpand).toHaveBeenCalledOnce();
  const url = onExpand.mock.calls[0]![0];
  try {
    const image = await fetch(url).then((response) => response.text());
    expect(image).toContain("<svg");
    expect(image).toContain("Start");
    expect(image).toContain("Finish");
    expect(image).not.toContain("__diagram_style_probe__");
  } finally {
    URL.revokeObjectURL(url);
  }
});
