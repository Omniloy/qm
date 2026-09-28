const TEXT_FILE = /\.(json|html|js|md)$/;

export function brandExtension(
  entries: Array<{ name: string; data: Buffer }>,
  selfLabel: string | undefined,
): { entries: Array<{ name: string; data: Buffer }>; filename: string } {
  const label = (selfLabel ?? "").replace(/[^\p{L}\p{N} ._-]/gu, "").trim() || "QM";
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return {
    entries: entries.map(({ name, data }) => ({
      name,
      data: TEXT_FILE.test(name) ? Buffer.from(data.toString("utf8").replace(/\bQM\b/g, label), "utf8") : data,
    })),
    filename: `${slug || "qm"}-browser-bridge.zip`,
  };
}
