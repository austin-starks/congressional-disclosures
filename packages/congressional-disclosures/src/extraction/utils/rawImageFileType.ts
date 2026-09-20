/** Image type from magic bytes; Senate paper pages are GIFs today. */
export function rawImageFileType(bytes: Buffer): { extension: string; contentType: string } {
  if (bytes.subarray(0, 4).toString("latin1") === "GIF8") return { extension: "gif", contentType: "image/gif" };
  if (bytes[0] === 0x89 && bytes.subarray(1, 4).toString("latin1") === "PNG") {
    return { extension: "png", contentType: "image/png" };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return { extension: "jpg", contentType: "image/jpeg" };
  throw new Error("unrecognized image bytes");
}
