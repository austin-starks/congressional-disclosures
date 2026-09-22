import { identifiedLake } from "../../tests/helpers";
import { buildPoliticalTradeEvents } from "../events";
import { senateElectronicFilingRows } from "../normalize";
import {
  amendedReport,
  amendedTransactions,
  initialReport,
  initialTransactions,
} from "./fixtures/senateOptionAmendment";

describe("lake normalization golden cases", () => {
  test("preserves a spouse-owned option partial sale and versions its amendment", () => {
    const initial = senateElectronicFilingRows(initialReport, initialTransactions);
    const amended = senateElectronicFilingRows(amendedReport, amendedTransactions);

    expect(initial.trades).toEqual([
      expect.objectContaining({
        owner: "spouse",
        action: "sale",
        partialSale: true,
        assetTypeLabel: "Stock Option",
        printedTicker: "NVDA",
        resolvedTicker: null,
        resolutionStatus: "printed",
        amountLow: 50_001,
        amountHigh: 100_000,
      }),
    ]);
    expect(amended.filing).toMatchObject({
      amendedReportDate: "2024-06-10",
      reportDate: "2024-06-10",
    });
    expect(amended.trades[0]).toMatchObject({
      filingStatus: "Amended",
      amountLow: 100_001,
      amountHigh: 250_000,
    });

    const lake = identifiedLake([initial.filing, amended.filing], [...initial.trades, ...amended.trades]);
    const events = buildPoliticalTradeEvents(lake.trades, lake.filings);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      version: 1,
      owner: "spouse",
      partialSale: true,
      ticker: "NVDA",
      amountLow: 50_001,
      amountHigh: 100_000,
      supersededAt: amended.filing.availableAt,
    });
    expect(events[1]).toMatchObject({
      eventId: events[0]?.eventId,
      version: 2,
      amountLow: 100_001,
      amountHigh: 250_000,
      firstAvailableAt: initial.filing.availableAt,
      availableAt: amended.filing.availableAt,
      supersededAt: null,
    });
  });
});
