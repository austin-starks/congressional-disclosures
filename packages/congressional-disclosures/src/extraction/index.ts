/**
 * The extraction pipeline, ported from NexusTrade's `politicalDisclosure` modules: schema-bound
 * PTR reads over PDFs, scanned-page OCR text and filed page images, with row-coverage proofs,
 * consensus over independent reads, and the planners that cut long filings into bounded requests.
 *
 * Everything vendor-side arrives through injected ports: model calls through `CompletionClient`
 * (ptrExtraction, ocrEngineFallback), page rendering/OCR/rasterization through the `Deps` records
 * of the orchestrators, and encrypted-PDF rewriting through `PdfDecrypt`.
 */
export type { CompletionClient, CompletionUsage } from "./ports";
export type { PdfDecrypt } from "./utils/decryptPdf";

export * from "./ocrRowNumbering";
export * from "./ocrPageGeometry";
export * from "./ocrPageCoverage";
export * from "./ocrPageRescale";
export * from "./pageOrientation";
export * from "./ptrRowCoverage";
export * from "./ptrConsensus";
export * from "./ptrGapFill";
export * from "./ptrExtraction";
export * from "./ptrReadPasses";
export * from "./ptrRequestPlan";
export * from "./ocrTextPlan";
export * from "./ocrEngineFallback";
export * from "./houseFilingExtraction";
export * from "./senatePaperExtraction";
