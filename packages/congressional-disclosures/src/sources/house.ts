import JSZip from "jszip";

import { fetchBuffer } from "./http";

export const HOUSE_PTR_FILING_TYPE = "P";
const HOUSE_CLERK_ORIGIN = "https://disclosures-clerk.house.gov";
const REQUIRED_COLUMNS = ["prefix", "last", "first", "suffix", "filingtype", "statedst", "year", "filingdate", "docid"] as const;
type IndexColumn = (typeof REQUIRED_COLUMNS)[number];

export interface HouseIndexFiling {
  indexYear: number;
  docId: string;
  filingType: string;
  filingDate: string;
  prefix: string;
  first: string;
  last: string;
  suffix: string;
  stateDistrict: string;
}

function headerKey(value: string): string {
  return value.replace(/^﻿/, "").trim().toLowerCase();
}

export function parseHouseIndexTsv(indexYear: number, text: string): HouseIndexFiling[] {
  const [headerLine, ...lines] = text.split(/\r?\n/);
  const headers = (headerLine ?? "").split("\t").map(headerKey);
  const positions = new Map<IndexColumn, number>();
  for (const column of REQUIRED_COLUMNS) {
    const position = headers.indexOf(column);
    if (position < 0) throw new Error(`House ${indexYear} index is missing the ${column} column`);
    positions.set(column, position);
  }
  const cell = (columns: string[], column: IndexColumn): string => (columns[positions.get(column) ?? -1] ?? "").trim();
  return lines.flatMap((line): HouseIndexFiling[] => {
    if (!line.trim()) return [];
    const columns = line.split("\t");
    const docId = cell(columns, "docid");
    if (!/^\d+$/.test(docId)) throw new Error(`House ${indexYear} index has a non-numeric DocID: "${docId}"`);
    return [{
      indexYear,
      docId,
      filingType: cell(columns, "filingtype").toUpperCase(),
      filingDate: cell(columns, "filingdate"),
      prefix: cell(columns, "prefix"),
      first: cell(columns, "first"),
      last: cell(columns, "last"),
      suffix: cell(columns, "suffix"),
      stateDistrict: cell(columns, "statedst"),
    }];
  });
}

export async function parseHouseIndexZip(indexYear: number, zip: Buffer): Promise<HouseIndexFiling[]> {
  const archive = await JSZip.loadAsync(zip);
  const entry = archive.file(`${indexYear}FD.txt`);
  if (!entry) throw new Error(`House ${indexYear} index ZIP has no ${indexYear}FD.txt`);
  return parseHouseIndexTsv(indexYear, await entry.async("string"));
}

export function housePeriodicTransactionReports(filings: readonly HouseIndexFiling[]): HouseIndexFiling[] {
  return filings.filter((filing) => filing.filingType === HOUSE_PTR_FILING_TYPE);
}

export function houseIndexZipUrl(year: number): string {
  return `${HOUSE_CLERK_ORIGIN}/public_disc/financial-pdfs/${year}FD.zip`;
}

export function housePtrPdfUrl(year: number, docId: string): string {
  return `${HOUSE_CLERK_ORIGIN}/public_disc/ptr-pdfs/${year}/${docId}.pdf`;
}

export function fetchHouseIndexZip(year: number): Promise<Buffer> {
  return fetchBuffer(houseIndexZipUrl(year));
}

export function fetchHousePtrPdf(year: number, docId: string): Promise<Buffer> {
  return fetchBuffer(housePtrPdfUrl(year, docId));
}
