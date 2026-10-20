import type { ThreadExportResult } from "@t3tools/contracts";

export async function shareThreadExport(result: ThreadExportResult): Promise<void> {
  const { Directory, File, Paths } = await import("expo-file-system");
  const { shareAsync } = await import("expo-sharing");
  const directory = new Directory(Paths.cache, `thread-export-${Date.now()}`);
  directory.create({ intermediates: true });
  const file = new File(directory, result.filename);
  try {
    file.create();
    file.write(result.content);
    await shareAsync(file.uri, {
      mimeType: result.mimeType,
      dialogTitle: "Export thread",
    });
  } finally {
    directory.delete();
  }
}
