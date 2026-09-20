import { PDFDocument } from "pdf-lib";

/**
 * Rewrites an encrypted PDF as an unencrypted copy of its pages. In the system this port
 * came from that was PDFium in a worker image (`python/decrypt_pdf.py`, spawned by
 * `utils/decryptPdf.ts`); the spawn, its interpreter resolution and its `process.env`
 * knobs are server-side, so here the decryptor is an injected port and an adapter
 * supplies PDFium or any equivalent. Supplying none makes an encrypted PDF fail loudly
 * at the split that needs it, which is the failure mode it must never hide.
 */
export type PdfDecrypt = (pdf: Buffer) => Promise<Buffer>;

/**
 * A PDF pdf-lib can copy pages out of. pdf-lib opens an encrypted PDF only with
 * `ignoreEncryption` and never decrypts it, so pages copied from one render blank:
 * every electronic House PTR is RC4-encrypted, and on 2026-09-16 both halves of a
 * 62-page filing came back with no rows. An encrypted PDF is rewritten unencrypted
 * by PDFium (`python/decrypt_pdf.py`); any other PDF is returned as is.
 */
export async function loadCopyablePdf(pdf: Buffer, decrypt?: PdfDecrypt): Promise<PDFDocument> {
  const document = await PDFDocument.load(pdf, { ignoreEncryption: true });
  if (!document.isEncrypted) return document;
  if (!decrypt) {
    throw new Error("encrypted PDF cannot be split: no PDF decryptor was provided");
  }
  return PDFDocument.load(await decrypt(pdf));
}
