import { existsSync } from "node:fs";

import { load } from "cheerio";
import type { Browser, Page } from "puppeteer-core" with { "resolution-mode": "import" };
import sharp from "sharp";

import { parseSlashDate } from "../lake/dates";
import { fetchWithRetry, readResponseBuffer } from "./http";

const EFD_ORIGIN = "https://efdsearch.senate.gov";
const HOME_PATH = "/search/home/";
const SEARCH_PATH = "/search/";
const REPORT_DATA_PATH = "/search/report/data/";
const REQUEST_TIMEOUT_MS = 60_000;
const SENSOR_SETTLE_MS = 5_000;
const AGREEMENT_CHECKBOX = "#agree_statement";
const SENATE_REQUEST_RETRIES = 4;
const SENATE_PAGE_SIZE = 100;
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

export interface SenateSearchPage {
  rows: SenateSearchRow[];
}

class SenateEfdHttpError extends Error {
  constructor(readonly status: number, path: string) {
    super(`Senate eFD ${path} returned HTTP ${status}`);
  }
}

function validatedReportPath(value: string): string {
  const url = new URL(value, EFD_ORIGIN);
  if (url.origin !== EFD_ORIGIN || url.username || url.password || url.search || url.hash) {
    throw new Error(`Untrusted Senate report URL: ${value}`);
  }
  senateReportId(url.pathname);
  return url.pathname;
}

function reportPathFromLink(linkHtml: string): string {
  const href = load(linkHtml)("a").attr("href");
  if (!href) throw new Error("Senate search row has no report link");
  return validatedReportPath(href);
}

export class SenateEfdSession {
  private closed = false;

  private constructor(private readonly browser: Browser, private readonly page: Page) {}

  /** Opens a temporary Firefox session. Callers must close it when finished. */
  static async open(acceptedTerms: boolean, firefoxExecutablePath?: string): Promise<SenateEfdSession> {
    if (!acceptedTerms) throw new Error("Senate access requires explicit acceptance of the eFD prohibition agreement");
    const defaultPaths = process.platform === "darwin"
      ? ["/Applications/Firefox.app/Contents/MacOS/firefox"]
      : process.platform === "linux" ? ["/usr/bin/firefox-esr", "/usr/bin/firefox"] : [];
    const executablePath = firefoxExecutablePath ?? defaultPaths.find((path) => existsSync(path));
    if (!executablePath) {
      throw new Error("Senate eFD requires Firefox. Install it or supply its executable path (--firefox-path in the CLI)");
    }
    const { default: puppeteer } = await import("puppeteer-core");
    const browser = await puppeteer.launch({
      browser: "firefox",
      executablePath,
      headless: true,
      timeout: REQUEST_TIMEOUT_MS,
    });
    try {
      const page = await browser.newPage();
      page.setDefaultNavigationTimeout(REQUEST_TIMEOUT_MS);
      page.setDefaultTimeout(REQUEST_TIMEOUT_MS);
      const session = new SenateEfdSession(browser, page);
      await session.acceptProhibitionAgreement();
      return session;
    } catch (error) {
      await browser.close().catch(() => undefined);
      throw error;
    }
  }

  /** Idempotent cleanup also runs when a listing or report fails. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.browser.close();
  }

  private async acceptProhibitionAgreement(): Promise<void> {
    const home = await this.page.goto(`${EFD_ORIGIN}${HOME_PATH}`, { waitUntil: "networkidle2" });
    if (home && !home.ok()) throw new SenateEfdHttpError(home.status(), HOME_PATH);
    // networkidle2 alone resolves before the sensor finishes. Submitting then
    // returns a blank 200 challenge instead of recording the agreement.
    await new Promise<void>((resolve) => setTimeout(resolve, SENSOR_SETTLE_MS));
    // The agreement checkbox can sit below Firefox's viewport. Scroll it into
    // view before clicking and wait for the final redirect to reach the search page.
    await this.page.$eval(AGREEMENT_CHECKBOX, (checkbox) => checkbox.scrollIntoView({ block: "center" }));
    const [agreement] = await Promise.all([
      this.page.waitForNavigation({ waitUntil: "networkidle2" }),
      this.page.click(AGREEMENT_CHECKBOX),
    ]);
    if (agreement && !agreement.ok() && agreement.status() !== 302) {
      throw new SenateEfdHttpError(agreement.status(), HOME_PATH);
    }
    try {
      const reachedSearch = await this.page.waitForFunction(
        (url) => location.href === url, {}, `${EFD_ORIGIN}${SEARCH_PATH}`,
      );
      await reachedSearch.dispose();
    } catch (cause) {
      throw new Error("Senate eFD agreement did not reach the report search page", { cause });
    }
    const hasCsrf = await this.page.evaluate(() =>
      document.cookie.split("; ").some((cookie) => cookie.startsWith("csrftoken=")),
    );
    if (!hasCsrf) throw new Error("Senate eFD agreement did not leave a csrftoken cookie");
  }

  private async request(path: string, body?: string): Promise<string> {
    if (this.closed) throw new Error("Senate eFD session is closed");
    for (let attempt = 0; ; attempt += 1) {
      try {
        const result = await this.page.evaluate(async (input) => {
          const form = input.body === undefined ? undefined : new URLSearchParams(input.body);
          if (form) {
            const cookie = document.cookie.split("; ").find((entry) => entry.startsWith("csrftoken="));
            if (!cookie) throw new Error("Senate eFD session lost its CSRF cookie");
            form.set("csrfmiddlewaretoken", decodeURIComponent(cookie.slice("csrftoken=".length)));
          }
          const response = await fetch(input.path, {
            method: form ? "POST" : "GET",
            credentials: "same-origin",
            ...(form ? {
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: form.toString(),
            } : {}),
            signal: AbortSignal.timeout(input.timeoutMs),
          });
          return { status: response.status, url: response.url, text: await response.text() };
        }, { path, body, timeoutMs: REQUEST_TIMEOUT_MS });
        if (result.status < 200 || result.status >= 300) throw new SenateEfdHttpError(result.status, path);
        if (result.url !== `${EFD_ORIGIN}${path}`) {
          throw new Error(`Senate eFD ${path} redirected away from the requested resource`);
        }
        return result.text;
      } catch (error) {
        const terminal = error instanceof SenateEfdHttpError &&
          error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;
        if (terminal || this.closed || attempt >= SENATE_REQUEST_RETRIES) throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      }
    }
  }

  /** All PTRs submitted on or after submittedStartDate (MM/DD/YYYY). */
  async searchPeriodicTransactionReports(submittedStartDate: string): Promise<SenateSearchRow[]> {
    const rows: SenateSearchRow[] = [];
    for (let start = 0; ; start += SENATE_PAGE_SIZE) {
      const page = await this.searchPeriodicTransactionReportPage({ start, length: SENATE_PAGE_SIZE, submittedStartDate });
      rows.push(...page.rows);
      if (page.rows.length < SENATE_PAGE_SIZE) return rows;
    }
  }

  /** One page of PTRs submitted on or after submittedStartDate (MM/DD/YYYY). */
  async searchPeriodicTransactionReportPage(options: {
    start: number;
    length: number;
    submittedStartDate: string;
  }): Promise<SenateSearchPage> {
    const form = new URLSearchParams({
      start: String(options.start),
      length: String(options.length),
      report_types: `[${SENATE_PTR_REPORT_TYPE}]`,
      filer_types: "[]",
      submitted_start_date: `${options.submittedStartDate} 00:00:00`,
      submitted_end_date: "",
      candidate_state: "",
      senator_state: "",
      office_id: "",
      first_name: "",
      last_name: "",
    });
    const payload: unknown = JSON.parse(await this.request(REPORT_DATA_PATH, form.toString()));
    if (!payload || typeof payload !== "object" || !("data" in payload) || !Array.isArray(payload.data)) {
      throw new Error("Senate eFD search response did not include a data array");
    }
    return {
      rows: payload.data.map((row: unknown): SenateSearchRow => {
        if (!Array.isArray(row) || row.length < 5 || !row.every((cell) => typeof cell === "string")) {
          throw new Error("Senate eFD search row is not five strings");
        }
        const [firstName = "", lastName = "", filerName = "", linkHtml = "", submittedDate = ""] = row;
        return {
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          filerName: filerName.trim(),
          reportPath: reportPathFromLink(linkHtml),
          reportTitle: load(linkHtml)("a").text().trim(),
          submittedDate: submittedDate.trim(),
        };
      }),
    };
  }

  async fetchReportHtml(reportPath: string): Promise<string> {
    return this.request(validatedReportPath(reportPath));
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
