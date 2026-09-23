import { identifiedLake } from "../../tests/helpers";
import { buildPoliticalTradeEvents } from "../events";
import { senateElectronicFilingRows, senateTickerFromAssetName } from "../normalize";
import { amendedReport, initialReport, initialTransaction } from "./fixtures/senateOptionAmendment";

/** Every string below is a real eFD Asset Name from a row whose Ticker column read "--". */
describe("senateTickerFromAssetName", () => {
  test("reads the ticker eFD put at the head of the asset name", () => {
    expect(senateTickerFromAssetName("SPYM - Tradr 2X Long SPY Monthly ETF", "Stock")).toBe("SPYM");
    expect(senateTickerFromAssetName("BRK-B - Berkshire Hathaway Inc Class B", "Stock")).toBe("BRK-B");
    expect(senateTickerFromAssetName("TFC.F - Truist FINL CORP F PFD", "Stock")).toBe("TFC.F");
    expect(senateTickerFromAssetName("JTKWY - Just Eat Takeaway.com NV - ADR", "Stock")).toBe("JTKWY");
    expect(senateTickerFromAssetName("GSMYX - GOLDMAN SACHS SM MD CAP GROWTH I", "Other")).toBe("GSMYX");
    expect(senateTickerFromAssetName("GBTC - Grayscale Bitcoin Trust Exchange/Platform: OTC", "Cryptocurrency")).toBe("GBTC");
  });

  test("refuses a bond, which names its issuer rather than itself", () => {
    expect(
      senateTickerFromAssetName(
        "FIS - Fidelity National Information Services 31620MBW5 Rate/Coupon: 4.700% Matures: 07/15/2027",
        "Corporate Bond",
      ),
    ).toBeNull();
  });

  test("refuses an exchange, which names two securities", () => {
    expect(
      senateTickerFromAssetName(
        "BBT.F - BB&T CORP F PERPTL PFD (Exchanged) TFC.F - TRUIST FINL CORP F PFD (Received)",
        "Stock",
      ),
    ).toBeNull();
  });

  test("leaves a plain name alone", () => {
    expect(senateTickerFromAssetName("NVIDIA Corporation call option", "Stock")).toBeNull();
    expect(senateTickerFromAssetName("US TSY NOTE - Due 05/31/28", "Other")).toBeNull();
  });
});

describe("a '--' ticker no longer splits an amendment from its original", () => {
  const spym = {
    ...initialTransaction,
    ticker: null,
    assetName: "SPYM - Tradr 2X Long SPY Monthly ETF",
    assetType: "Stock",
    owner: "Self",
    transactionType: "Purchase",
    amount: "$1,001 - $15,000",
    comment: null,
  };

  test("consolidates into one event with two versions", () => {
    const initial = senateElectronicFilingRows(initialReport, [spym]);
    const amended = senateElectronicFilingRows(amendedReport, [{ ...spym, amount: "$15,001 - $50,000" }]);
    expect(initial.trades[0]).toMatchObject({ printedTicker: "SPYM", resolutionStatus: "printed" });
    expect(initial.trades[0]?.assetDescription).toBe("SPYM - Tradr 2X Long SPY Monthly ETF");

    const lake = identifiedLake([initial.filing, amended.filing], [...initial.trades, ...amended.trades]);
    const events = buildPoliticalTradeEvents(lake.trades, lake.filings);
    expect(new Set(events.map((event) => event.eventId)).size).toBe(1);
    expect(events.map((event) => event.version)).toEqual([1, 2]);
  });
});
