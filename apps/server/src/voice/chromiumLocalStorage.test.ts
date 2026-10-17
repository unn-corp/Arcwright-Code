import { describe, expect, it } from "vite-plus/test";
import { chromiumStorageFiles, decodeChromiumLocalStorage } from "./chromiumLocalStorage.ts";
import { storageLog, storageManifest, storageTable } from "./testFixtures/chromiumStorage.ts";

const keys = new Set(["model", "endpoint", "deleted", "unicode"]);
describe("read-only Chromium preferences", () => {
  it("applies later WAL updates and tombstones and ignores other website origins", () => {
    const files = new Map([
      [
        "000003.log",
        storageLog([
          ["model", "old"],
          ["deleted", "stale"],
          ["unicode", "日本語"],
        ]),
      ],
      [
        "000004.log",
        storageLog(
          [
            ["model", "new"],
            ["deleted", null],
          ],
          20,
        ),
      ],
      ["000005.log", storageLog([["model", "foreign"]], 40, "https://unrelated.example")],
    ]);
    expect(Object.fromEntries(decodeChromiumLocalStorage(files, keys))).toEqual({
      model: "new",
      unicode: "日本語",
    });
  });
  it("reassembles fragmented records and ignores an incomplete final append", () => {
    const text = "A".repeat(40000);
    const bytes = Buffer.concat([
      storageLog([["model", text]]),
      storageLog([["model", "unfinished"]], 100).subarray(0, 10),
    ]);
    expect(decodeChromiumLocalStorage(new Map([["000003.log", bytes]]), keys).get("model")).toBe(
      text,
    );
  });
  it("rejects a damaged complete WAL record", () => {
    const bytes = storageLog([["model", "hello"]]);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    expect(() => decodeChromiumLocalStorage(new Map([["000003.log", bytes]]), keys)).toThrow(
      "checksum",
    );
  });
  it("uses the manifest rather than resurrecting records from obsolete files", () => {
    expect(
      chromiumStorageFiles(storageManifest([7], 9), [
        "000003.log",
        "000007.ldb",
        "000008.ldb",
        "000009.log",
        "000010.log",
        "LOCK",
      ]),
    ).toEqual(["000007.ldb", "000009.log", "000010.log"]);
  });
  it.each([undefined, 1, 2, 4] as const)(
    "reads compacted SST preferences with compression %s",
    (compression) => {
      const files = new Map([
        [
          "000007.ldb",
          storageTable(
            [
              ["model", "A".repeat(100)],
              ["endpoint", "https://speech.example/v1"],
              ["deleted", "stale"],
            ],
            1,
            compression,
          ),
        ],
        ["000009.log", storageLog([["deleted", null]], 50)],
      ]);
      expect(Object.fromEntries(decodeChromiumLocalStorage(files, keys))).toEqual({
        model: "A".repeat(100),
        endpoint: "https://speech.example/v1",
      });
    },
  );
  it("rejects a damaged SST block", () => {
    const table = storageTable([["model", "hello"]]);
    table[4] = table[4]! ^ 1;
    expect(() => decodeChromiumLocalStorage(new Map([["000007.ldb", table]]), keys)).toThrow(
      "checksum",
    );
  });
  it("fails rather than using stale values when a live table is missing", () => {
    expect(() =>
      chromiumStorageFiles(storageManifest([7], 9), ["000003.log", "000008.ldb"]),
    ).toThrow("Missing live LevelDB table");
  });
});
