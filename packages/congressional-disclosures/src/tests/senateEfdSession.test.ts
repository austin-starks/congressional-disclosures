import puppeteer from "puppeteer-core";

import { fetchSenateMedia, SenateEfdSession } from "../sources/senate";

jest.mock("puppeteer-core", () => ({ __esModule: true, default: { launch: jest.fn() } }));

const origin = "https://efdsearch.senate.gov";
const reportPath = "/search/view/ptr/11111111-1111-1111-1111-111111111111/";
const close = jest.fn();
const evaluate = jest.fn();
const goto = jest.fn();
const navigation = jest.fn();
const waitForSearch = jest.fn();
const page = {
  goto, evaluate, waitForNavigation: navigation, waitForFunction: waitForSearch,
  $eval: jest.fn(),
  click: jest.fn(), setDefaultTimeout: jest.fn(), setDefaultNavigationTimeout: jest.fn(),
};

async function openSession(): Promise<SenateEfdSession> {
  const opening = SenateEfdSession.open(true, "/test/firefox");
  // Flush the dynamic import and page initialization before the sensor timer.
  for (let i = 0; i < 20; i++) await Promise.resolve();
  jest.advanceTimersByTime(5000);
  return opening;
}

function response(path: string, text: string, status = 200) {
  return { status, url: `${origin}${path}`, text };
}

describe("senateEfdClient", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    evaluate.mockReset().mockResolvedValue(true);
    goto.mockReset().mockResolvedValue({ ok: () => true });
    navigation.mockReset().mockResolvedValue({ ok: () => true });
    waitForSearch.mockReset().mockResolvedValue({ dispose: async () => {} });
    close.mockReset().mockResolvedValue(undefined);
    (puppeteer.launch as jest.Mock).mockReset().mockResolvedValue({ newPage: async () => page, close });
  });

  afterEach(() => jest.useRealTimers());

  it("requires explicit acceptance before launching Firefox", async () => {
    await expect(SenateEfdSession.open(false)).rejects.toThrow("explicit acceptance");
    expect(puppeteer.launch).not.toHaveBeenCalled();
  });

  it("paginates the public all-results search", async () => {
    const session = await openSession();
    const row = ["First", "Last", "Name", `<a href="${reportPath}">PTR</a>`, "10/23/2026"];
    evaluate.mockResolvedValueOnce(response("/search/report/data/", JSON.stringify({ data: Array.from({ length: 100 }, () => row) })));
    evaluate.mockResolvedValueOnce(response("/search/report/data/", JSON.stringify({ data: [row] })));
    expect(await session.searchPeriodicTransactionReports("10/01/2026")).toHaveLength(101);
    expect(new URLSearchParams(evaluate.mock.calls[2][1].body).get("start")).toBe("100");
    await session.close();
  });

  it("rejects paper media URLs outside the official Senate hosts before fetching", async () => {
    await expect(fetchSenateMedia("https://example.com/filing.gif")).rejects.toThrow(
      "Untrusted Senate media URL",
    );
  });

  it("keeps search and concurrent report reads in the browser, and closes once", async () => {
    navigation.mockResolvedValueOnce({ ok: () => false, status: () => 302 });
    const session = await openSession();
    expect(page.$eval).toHaveBeenCalledWith("#agree_statement", expect.any(Function));
    expect(waitForSearch).toHaveBeenCalledWith(expect.any(Function), {}, `${origin}/search/`);
    evaluate.mockResolvedValueOnce(response("/search/report/data/", JSON.stringify({ data: [[
      " First ", " Last ", " Name ", `<a href="${reportPath}">Periodic Transaction Report</a>`, "10/23/2026",
    ]] })));
    const result = await session.searchPeriodicTransactionReportPage({ start: 100, length: 100, submittedStartDate: "10/01/2026" });
    expect(result.rows).toEqual([{
      firstName: "First", lastName: "Last", filerName: "Name", reportPath,
      reportTitle: "Periodic Transaction Report", submittedDate: "10/23/2026",
    }]);
    const input = evaluate.mock.calls[1][1];
    expect(new URLSearchParams(input.body).get("start")).toBe("100");
    expect(new URLSearchParams(input.body).get("submitted_start_date")).toBe("10/01/2026 00:00:00");
    evaluate.mockResolvedValue(response(reportPath, "<html>report</html>"));
    expect(await Promise.all([session.fetchReportHtml(reportPath), session.fetchReportHtml(reportPath)])).toEqual([
      "<html>report</html>", "<html>report</html>",
    ]);
    await session.close();
    await session.close();
    expect(close).toHaveBeenCalledTimes(1);
    await expect(session.fetchReportHtml(reportPath)).rejects.toThrow("session is closed");
  });

  it("rejects external and malformed report paths before a browser request", async () => {
    const session = await openSession();
    for (const path of [`https://example.com${reportPath}`, "/search/home/", `${reportPath}?redirect=1`]) {
      await expect(session.fetchReportHtml(path)).rejects.toThrow();
    }
    expect(evaluate).toHaveBeenCalledTimes(1);
    await session.close();
  });

  it("rejects a search link on a different host", async () => {
    const session = await openSession();
    evaluate.mockResolvedValueOnce(response("/search/report/data/", JSON.stringify({ data: [[
      "First", "Last", "Name", `<a href="https://example.com${reportPath}">PTR</a>`, "10/23/2026",
    ]] })));
    await expect(session.searchPeriodicTransactionReportPage({ start: 0, length: 100, submittedStartDate: "10/01/2026" }))
      .rejects.toThrow("Untrusted Senate report URL");
    await session.close();
  });

  it("reports a terminal refusal immediately with the endpoint and status", async () => {
    const session = await openSession();
    evaluate.mockResolvedValueOnce(response(reportPath, "Access Denied", 403));
    await expect(session.fetchReportHtml(reportPath)).rejects.toThrow(`${reportPath} returned HTTP 403`);
    expect(evaluate).toHaveBeenCalledTimes(2);
    await session.close();
  });

  it("rejects a redirected agreement page instead of returning report HTML", async () => {
    const session = await openSession();
    evaluate.mockResolvedValue(response("/search/home/", "agreement"));
    const rejection = expect(session.fetchReportHtml(reportPath)).rejects.toThrow("redirected away");
    await jest.runAllTimersAsync();
    await rejection;
    await session.close();
  });

  it("closes failed initialization and does not mistake HTTP 200 for acceptance", async () => {
    waitForSearch.mockRejectedValue(new Error("search page did not load"));
    await expect(openSession()).rejects.toThrow("did not reach the report search page");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes a browser whose initial page was refused", async () => {
    goto.mockResolvedValueOnce({ ok: () => false, status: () => 403 });
    await expect(openSession()).rejects.toThrow("/search/home/ returned HTTP 403");
    expect(close).toHaveBeenCalledTimes(1);
  });
});
