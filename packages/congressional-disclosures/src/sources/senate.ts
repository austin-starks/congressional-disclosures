import { load } from "cheerio";
import sharp from "sharp";

import { parseSlashDate } from "../lake/dates";
import { fetchWithRetry, readResponseBuffer } from "./http";

const EFD_ORIGIN = "https://efdsearch.senate.gov";
const HOME_PATH = "/search/home/";
const SEARCH_PATH = "/search/";
const REPORT_DATA_PATH = "/search/report/data/";
const SENATE_MEDIA_ORIGINS = new Set([
  EFD_ORIGIN,
  "https://efd-media-public.senate.gov",
]);
const SENATE_MEDIA_REDIRECTS = new Set([301, 302, 303, 307, 308]);
const SENATE_MEDIA_MAX_REDIRECTS = 5;
export const SENATE_MEDIA_MAX_BYTES = 64 * 1024 * 1024;
export const SENATE_PTR_REPORT_TYPE = 11;

export interface SenateSearchRow {
  firstName: string;
  lastName: string;
  filerName: string;
  reportPath: string;
  reportTitle: string;
  submittedDate: string;
}

export type SenateReportKind = "electronic" | "paper";
const REPORT_PATH = /^\/search\/view\/(ptr|paper)\/([0-9a-f-]{36})\/$/i;
const ELECTRONIC_COLUMNS = ["#", "Transaction Date", "Owner", "Ticker", "Asset Name", "Asset Type", "Type", "Amount", "Comment"] as const;

export interface SenateElectronicTransaction {
  rowNumber: number;
  transactionDate: string;
  owner: string;
  ticker: string | null;
  assetName: string;
  assetType: string;
  transactionType: string;
  amount: string;
  comment: string | null;
}

export interface SenateReportTitle {
  reportDate: string;
  amendment: "none" | "numbered" | "unnumbered";
}

function parseReportPath(reportPath: string): { kind: SenateReportKind; reportId: string } {
  const match = REPORT_PATH.exec(reportPath);
  if (!match?.[1] || !match[2]) throw new Error(`Unrecognized Senate report path: ${reportPath}`);
  return { kind: match[1].toLowerCase() === "ptr" ? "electronic" : "paper", reportId: match[2] };
}

export function senateReportKind(reportPath: string): SenateReportKind {
  return parseReportPath(reportPath).kind;
}

export function senateReportId(reportPath: string): string {
  return parseReportPath(reportPath).reportId;
}

const REPORT_TITLE = /^Periodic Transaction Report for (\d{2}\/\d{2}\/\d{4})(?: \(Amendment( \d+)?\))?$/;

export function parseSenateReportTitle(title: string): SenateReportTitle | null {
  const match = REPORT_TITLE.exec(title.trim());
  if (!match?.[1]) return null;
  let reportDate: string | null;
  try {
    reportDate = parseSlashDate(match[1]);
  } catch {
    return null;
  }
  if (!reportDate) return null;
  if (!title.includes("(Amendment")) return { reportDate, amendment: "none" };
  return { reportDate, amendment: match[2] ? "numbered" : "unnumbered" };
}

export function senateMediaUrl(value: string, base: string = EFD_ORIGIN): string {
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    throw new Error(`Invalid Senate media URL: ${value}`);
  }
  if (!SENATE_MEDIA_ORIGINS.has(url.origin) || url.username || url.password) {
    throw new Error(`Untrusted Senate media URL: ${url.href}`);
  }
  return url.href;
}

export function senatePaperPageImageUrls(html: string): string[] {
  const $ = load(html);
  return $("img.filingImage").toArray()
    .map((image) => $(image).attr("src")?.trim() ?? "")
    .filter(Boolean)
    .map((url) => senateMediaUrl(url));
}

export function isTiffImage(bytes: Buffer): boolean {
  return bytes.length >= 4 && (
    bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00 ||
    bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a
  );
}

export async function normalizeSenatePaperPageImage(image: Buffer): Promise<Buffer> {
  return isTiffImage(image) ? sharp(image).png().toBuffer() : image;
}

function cellText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function dashAsNull(value: string): string | null {
  return value === "--" || value === "" ? null : value;
}

export function parseSenateElectronicPtr(html: string): SenateElectronicTransaction[] {
  const $ = load(html);
  const tables = $("table").toArray().filter((table) => {
    const headers = $(table).find("thead th").toArray().map((th) => cellText($(th).text()));
    return headers.includes("Transaction Date") && headers.includes("Amount");
  });
  if (tables.length !== 1 || !tables[0]) throw new Error(`Expected one Senate transaction table, found ${tables.length}`);
  const table = $(tables[0]);
  const headers = table.find("thead th").toArray().map((th) => cellText($(th).text()));
  if (headers.join("|") !== ELECTRONIC_COLUMNS.join("|")) {
    throw new Error(`Unexpected Senate transaction columns: ${headers.join(", ")}`);
  }
  return table.find("tbody tr").toArray().map((row): SenateElectronicTransaction => {
    const cells = $(row).find("td").toArray().map((td) => cellText($(td).text()));
    if (cells.length !== ELECTRONIC_COLUMNS.length || cells.some((cell) => cell === undefined)) {
      throw new Error(`Senate transaction row has ${cells.length} cells`);
    }
    const [rowNumber, transactionDate, owner, ticker, assetName, assetType, type, amount, comment] =
      cells as [string, string, string, string, string, string, string, string, string];
    return {
      rowNumber: Number(rowNumber), transactionDate, owner, ticker: dashAsNull(ticker), assetName,
      assetType, transactionType: type, amount, comment: dashAsNull(comment),
    };
  });
}

function reportPathFromLink(linkHtml: string): string {
  const href = load(linkHtml)("a").attr("href");
  if (!href) throw new Error("Senate search row has no report link");
  return new URL(href, EFD_ORIGIN).pathname;
}

export class SenateEfdSession {
  private readonly cookies = new Map<string, string>();
  private constructor() {}

  static async open(acceptedTerms: boolean): Promise<SenateEfdSession> {
    if (!acceptedTerms) throw new Error("Senate access requires explicit acceptance of the eFD prohibition agreement");
    const session = new SenateEfdSession();
    await session.acceptAgreement();
    return session;
  }

  private cookieHeader(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  private storeCookies(response: Response): void {
    for (const cookie of response.headers.getSetCookie()) {
      const [pair = ""] = cookie.split(";");
      const separator = pair.indexOf("=");
      if (separator > 0) this.cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
    }
  }

  private headers(referer: string): Record<string, string> {
    return { Cookie: this.cookieHeader(), Referer: `${EFD_ORIGIN}${referer}` };
  }

  private async acceptAgreement(): Promise<void> {
    const home = await fetchWithRetry(`${EFD_ORIGIN}${HOME_PATH}`);
    this.storeCookies(home);
    const html = await home.text();
    const token = load(html)('input[name="csrfmiddlewaretoken"]').attr("value");
    if (!token) throw new Error("Senate eFD home page did not include a CSRF token");
    const body = new URLSearchParams({ csrfmiddlewaretoken: token, prohibition_agreement: "1" });
    const agreement = await fetchWithRetry(`${EFD_ORIGIN}${HOME_PATH}`, {
      method: "POST", redirect: "manual", body,
      headers: { ...this.headers(HOME_PATH), "Content-Type": "application/x-www-form-urlencoded" },
    }, { acceptedStatuses: [302] });
    this.storeCookies(agreement);
    if (!this.cookies.has("csrftoken")) throw new Error("Senate eFD agreement did not leave a csrftoken cookie");
  }

  async searchPeriodicTransactionReports(submittedStartDate: string): Promise<SenateSearchRow[]> {
    const rows: SenateSearchRow[] = [];
    const length = 100;
    for (let start = 0; ; start += length) {
      const form = new URLSearchParams({
        start: String(start), length: String(length), report_types: `[${SENATE_PTR_REPORT_TYPE}]`, filer_types: "[]",
        submitted_start_date: `${submittedStartDate} 00:00:00`, submitted_end_date: "", candidate_state: "",
        senator_state: "", office_id: "", first_name: "", last_name: "",
        csrfmiddlewaretoken: this.cookies.get("csrftoken") ?? "",
      });
      const response = await fetchWithRetry(`${EFD_ORIGIN}${REPORT_DATA_PATH}`, {
        method: "POST", body: form,
        headers: { ...this.headers(SEARCH_PATH), Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      });
      this.storeCookies(response);
      const payload: unknown = await response.json();
      if (!payload || typeof payload !== "object" || !("data" in payload) || !Array.isArray(payload.data)) {
        throw new Error("Senate eFD search response did not include a data array");
      }
      const page = payload.data.map((row: unknown): SenateSearchRow => {
        if (!Array.isArray(row) || row.length < 5 || !row.every((cell) => typeof cell === "string")) {
          throw new Error("Senate eFD search row is not five strings");
        }
        const [firstName = "", lastName = "", filerName = "", linkHtml = "", submittedDate = ""] = row;
        return {
          firstName: firstName.trim(), lastName: lastName.trim(), filerName: filerName.trim(),
          reportPath: reportPathFromLink(linkHtml), reportTitle: load(linkHtml)("a").text().trim(),
          submittedDate: submittedDate.trim(),
        };
      });
      rows.push(...page);
      if (page.length < length) return rows;
    }
  }

  async fetchReportHtml(reportPath: string): Promise<string> {
    const response = await fetchWithRetry(`${EFD_ORIGIN}${reportPath}`, { headers: this.headers(SEARCH_PATH) });
    this.storeCookies(response);
    return response.text();
  }
}

export async function fetchSenateMedia(url: string): Promise<Buffer> {
  let current = senateMediaUrl(url);
  for (let redirect = 0; redirect <= SENATE_MEDIA_MAX_REDIRECTS; redirect += 1) {
    const response = await fetchWithRetry(
      current,
      { redirect: "manual" },
      { acceptedStatuses: [...SENATE_MEDIA_REDIRECTS] }
    );
    if (!SENATE_MEDIA_REDIRECTS.has(response.status)) {
      return normalizeSenatePaperPageImage(await readResponseBuffer(response, SENATE_MEDIA_MAX_BYTES));
    }
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location) throw new Error(`Senate media redirect from ${current} omitted Location`);
    current = senateMediaUrl(location, current);
  }
  throw new Error(`Senate media exceeded ${SENATE_MEDIA_MAX_REDIRECTS} redirects`);
}
