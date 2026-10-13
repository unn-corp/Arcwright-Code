import { afterEach, expect, it, vi } from "vite-plus/test";
import { profileThumbnail } from "./ParticipantProfileSettings";
afterEach(() => vi.unstubAllGlobals());

it("rejects non-raster and oversized uploads before decoding", async () => {
  const decode = vi.fn();
  vi.stubGlobal("createImageBitmap", decode);
  await expect(profileThumbnail({ type: "image/svg+xml", size: 100 } as File)).rejects.toThrow(
    "Choose a PNG",
  );
  await expect(profileThumbnail({ type: "image/png", size: 10_000_001 } as File)).rejects.toThrow(
    "smaller than 10 MB",
  );
  expect(decode).not.toHaveBeenCalled();
});
it("crops to a bounded square and closes decoded image resources", async () => {
  const bitmap = { width: 300, height: 100, close: vi.fn() };
  vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(bitmap));
  const drawImage = vi.fn();
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage }),
    toDataURL: () => "data:image/webp;base64,AA==",
  };
  vi.stubGlobal("document", { createElement: () => canvas });
  const photo = await profileThumbnail({ type: "image/png", size: 100 } as File);
  expect(photo).toBe("data:image/webp;base64,AA==");
  expect(canvas.width).toBe(96);
  expect(canvas.height).toBe(96);
  expect(drawImage).toHaveBeenCalledWith(bitmap, 100, 0, 100, 100, 0, 0, 96, 96);
  expect(bitmap.close).toHaveBeenCalledOnce();
});
it("rejects an oversized thumbnail and still releases resources", async () => {
  const close = vi.fn();
  vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue({ width: 100, height: 100, close }));
  vi.stubGlobal("document", {
    createElement: () => ({
      getContext: () => ({ drawImage: vi.fn() }),
      toDataURL: () => "data:image/png;base64," + "A".repeat(16_384),
    }),
  });
  await expect(profileThumbnail({ type: "image/png", size: 100 } as File)).rejects.toThrow(
    "too detailed",
  );
  expect(close).toHaveBeenCalledOnce();
});
