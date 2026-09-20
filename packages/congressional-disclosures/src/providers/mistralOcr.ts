import { LocalCache, requestHash } from "../runtime/cache";

export interface OcrPageResult {
  markdown: string;
  payload: Record<string, unknown>;
}

export interface OcrClient {
  readImage(image: Buffer, label: string): Promise<OcrPageResult>;
  readPdf(pdf: Buffer, label: string): Promise<OcrPageResult[]>;
}

export interface MistralOcrConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  cache?: LocalCache;
}

function imageContentType(image: Buffer): string {
  if (image.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (image[0] === 0xff && image[1] === 0xd8) return "image/jpeg";
  if (image.subarray(0, 6).toString("ascii").startsWith("GIF8")) return "image/gif";
  throw new Error("OCR image must be PNG, JPEG, or GIF");
}

function pagesOf(payload: Record<string, unknown>): OcrPageResult[] {
  if (!Array.isArray(payload.pages)) throw new Error("Mistral OCR response has no pages array");
  return payload.pages.map((page, index) => {
    if (!page || typeof page !== "object") throw new Error(`Mistral OCR page ${index + 1} is not an object`);
    const object = page as Record<string, unknown>;
    if (typeof object.markdown !== "string") throw new Error(`Mistral OCR page ${index + 1} has no markdown`);
    return { markdown: object.markdown, payload: object };
  });
}

export class MistralOcrClient implements OcrClient {
  private readonly endpoint: string;
  private readonly model: string;
  constructor(private readonly config: MistralOcrConfig) {
    this.endpoint = `${(config.baseUrl ?? "https://api.mistral.ai/v1").replace(/\/$/, "")}/ocr`;
    this.model = config.model ?? "mistral-ocr-latest";
  }

  private async request(document: Record<string, unknown>, cacheBytes: Buffer, label: string): Promise<OcrPageResult[]> {
    const key = `mistral-ocr-${requestHash(this.model, label, cacheBytes)}`;
    const cached = await this.config.cache?.readJson(key);
    if (cached) return pagesOf(cached);
    const response = await fetch(this.endpoint, {
      method: "POST", signal: AbortSignal.timeout(180_000),
      headers: { Authorization: `Bearer ${this.config.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, document }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Mistral OCR ${response.status}: ${text.slice(0, 500)}`);
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") throw new Error("Mistral OCR returned a non-object response");
    const payload = parsed as Record<string, unknown>;
    await this.config.cache?.writeJson(key, payload);
    return pagesOf(payload);
  }

  async readImage(image: Buffer, label: string): Promise<OcrPageResult> {
    const pages = await this.request({ type: "image_url", image_url: `data:${imageContentType(image)};base64,${image.toString("base64")}` }, image, label);
    if (pages.length !== 1 || !pages[0]) throw new Error(`Mistral OCR returned ${pages.length} pages for ${label}`);
    return pages[0];
  }

  readPdf(pdf: Buffer, label: string): Promise<OcrPageResult[]> {
    return this.request({ type: "document_url", document_url: `data:application/pdf;base64,${pdf.toString("base64")}` }, pdf, label);
  }
}
