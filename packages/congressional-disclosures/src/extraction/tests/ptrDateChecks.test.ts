import { describePtrRow, ptrRowDateFindings } from "../ptrDateChecks";

function row(transaction: string | null, notification: string | null): Record<string, unknown> {
  return { transaction_date_iso: transaction, notification_date_iso: notification, ocr_rows: [7] };
}

describe("ptrRowDateFindings", () => {
  it("finds a handwritten year read ten years early (Kelly 8219843: 6/1/23 published as 2013)", () => {
    expect(ptrRowDateFindings(row("2013-06-01", "2023-07-03"), "2023-07-18")).toEqual([
      "transaction date 2013-06-01 is more than a year before its notification date 2023-07-03",
    ]);
  });

  it("finds a notification read after the day the report was filed (Harshbarger 8218621: 03/22/22 read as 09/22/22)", () => {
    expect(ptrRowDateFindings(row("2022-03-07", "2022-09-22"), "2022-03-29")).toEqual([
      "notification date 2022-09-22 is more than a month after the report was filed on 2022-03-29",
    ]);
  });

  it("finds a transaction after the filing, and one a month after its own notification (a January year slip)", () => {
    expect(ptrRowDateFindings(row("2022-04-02", "2022-03-30"), "2022-04-01")).toEqual([
      "transaction date 2022-04-02 is after the report was filed on 2022-04-01",
    ]);
    expect(ptrRowDateFindings(row("2017-12-29", "2017-01-05"), "2018-01-09")).toEqual([
      "transaction date 2017-12-29 is more than a month after its notification date 2017-01-05",
    ]);
  });

  it("leaves the few days out of order that filers print", () => {
    expect(ptrRowDateFindings(row("2022-04-20", "2022-03-30"), "2022-04-25")).toEqual([]);
    expect(ptrRowDateFindings(row("2022-03-01", "2022-04-28"), "2022-04-01")).toEqual([]);
  });

  it("finds nothing on dates that fit together, on the filing day itself, or without the dates to compare", () => {
    expect(ptrRowDateFindings(row("2022-03-07", "2022-03-22"), "2022-03-22")).toEqual([]);
    expect(ptrRowDateFindings(row("2022-03-07", "2023-03-07"), "2023-03-10")).toEqual([]);
    expect(ptrRowDateFindings(row("2022-03-07", null), null)).toEqual([]);
    expect(ptrRowDateFindings(row(null, "2022-03-22"), "2022-04-01")).toEqual([]);
    expect(ptrRowDateFindings(row("not a date", "2022-03-22"), "2022-04-01")).toEqual([]);
  });

  it("checks the row's own dates when the filing date is unknown or not a calendar date", () => {
    expect(ptrRowDateFindings(row("2013-06-01", "2023-07-03"), null)).toHaveLength(1);
    // A string comparison against "7/18/2023" would call every 2023 date after the filing.
    expect(ptrRowDateFindings(row("2023-06-01", "2023-07-03"), "7/18/2023")).toEqual([]);
  });
});

describe("describePtrRow", () => {
  it("names a row by its OCR labels, else by its page and asset", () => {
    expect(describePtrRow({ ocr_rows: [4, 5] })).toBe("the row labeled 4, 5");
    expect(describePtrRow({ ocr_rows: [], page: 2, asset_description: "CME GROUP INC" })).toBe(
      "a row on page 2 (CME GROUP INC)"
    );
  });
});
