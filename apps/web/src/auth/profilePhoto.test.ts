import { expect, it } from "vite-plus/test";
import { serializeProfilePhoto } from "./profilePhoto";

it("finishes an older refresh before an account upload while other accounts remain independent", async () => {
  const events: string[] = [];
  let finish!: () => void;
  const refresh = serializeProfilePhoto("alice", async () => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    events.push("old refresh published");
  });
  const upload = serializeProfilePhoto("alice", async () => {
    events.push("new photo published");
  });
  await serializeProfilePhoto("bob", async () => {
    events.push("bob unaffected");
  });
  expect(events).toEqual(["bob unaffected"]);
  finish();
  await Promise.all([refresh, upload]);
  expect(events).toEqual(["bob unaffected", "old refresh published", "new photo published"]);
});
it("does not leave later account updates blocked after a failed request", async () => {
  await expect(
    serializeProfilePhoto("alice", async () => {
      throw new Error("Offline");
    }),
  ).rejects.toThrow("Offline");
  await expect(serializeProfilePhoto("alice", async () => "new image")).resolves.toBe("new image");
});
