import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { auditPoliticalIntegrity } from "../../integrity";
import { buildPoliticalTradeEvents } from "../../lake/events";
import { filingFixture, tradeFixture } from "../../tests/helpers";
import { identifyPoliticalRows } from "../apply";
import { legislatorsFromFiles, loadLegislators, type LegislatorsFetch } from "../legislators";
import { MEMBER_OVERRIDES } from "../overrides";
import { MemberResolver, nameTokens } from "../resolve";
import type { IdentityInput, Legislator, LegislatorsSnapshot, LegislatorTerm } from "../types";

function term(type: LegislatorTerm["type"], state: string, district: number | null, start: string, end: string): LegislatorTerm {
  return { type, state, district, start, end };
}

function member(bioguide: string, first: string, last: string, terms: LegislatorTerm[], extra: Partial<Legislator> = {}): Legislator {
  return { bioguide, first, middle: null, nickname: null, last, officialFull: null, terms, ...extra };
}

/** Real congress-legislators records (bioguide IDs, seats, dates), trimmed to what resolution reads. */
const LEGISLATORS: Legislator[] = [
  member("F000472", "C.", "Franklin", [
    term("rep", "FL", 15, "2021-01-03", "2023-01-03"),
    term("rep", "FL", 18, "2023-01-03", "2027-01-03"),
  ], { middle: "Scott", officialFull: "Scott Franklin" }),
  member("D000354", "John", "Dingell", [term("rep", "MI", 15, "1933-03-09", "1957-01-03")], { middle: "David" }),
  member("D000355", "John", "Dingell", [
    term("rep", "MI", 15, "1955-01-05", "2003-01-03"),
    term("rep", "MI", 12, "2013-01-03", "2015-01-03"),
  ], { middle: "David", officialFull: "John D. Dingell" }),
  member("D000624", "Debbie", "Dingell", [
    term("rep", "MI", 12, "2015-01-06", "2023-01-03"),
    term("rep", "MI", 6, "2023-01-03", "2027-01-03"),
  ], { officialFull: "Debbie Dingell" }),
  member("D000622", "Ladda", "Duckworth", [
    term("rep", "IL", 8, "2013-01-03", "2017-01-03"),
    term("sen", "IL", null, "2017-01-03", "2029-01-03"),
  ], { middle: "Tammy", officialFull: "Tammy Duckworth" }),
  member("S001184", "Tim", "Scott", [term("sen", "SC", null, "2013-01-02", "2029-01-03")], { officialFull: "Tim Scott" }),
  member("S001217", "Rick", "Scott", [term("sen", "FL", null, "2019-01-08", "2031-01-03")], { officialFull: "Rick Scott" }),
  member("G000535", "Luis", "Gutiérrez", [term("rep", "IL", 4, "1993-01-05", "2019-01-03")], { officialFull: "Luis V. Gutiérrez" }),
  member("D000628", "Neal", "Dunn", [term("rep", "FL", 2, "2017-01-03", "2027-01-03")], { officialFull: "Neal P. Dunn" }),
  member("H001091", "Ashley", "Hinson", [term("rep", "IA", 1, "2021-01-03", "2027-01-03")], { officialFull: "Ashley Hinson" }),
];

const SNAPSHOT: LegislatorsSnapshot = {
  commit: "73e2fcd181e1c48d1b0580d417e8d0314b22f7c9",
  sha256: { current: "0".repeat(64), historical: "0".repeat(64) },
  legislators: LEGISLATORS,
};

const resolver = new MemberResolver(SNAPSHOT);

function filing(chamber: IdentityInput["chamber"], filerFirst: string, filerLast: string, stateDistrict: string | null, filingDate: string): IdentityInput {
  return { chamber, filerFirst, filerLast, stateDistrict, filingDate };
}

describe("MemberResolver", () => {
  test("merges the four ways the House Clerk has spelled Scott Franklin", () => {
    const identities = [
      filing("house", "Scott", "Franklin", "FL15", "2021-06-01"),
      filing("house", "C. Scott", "Franklin", "FL18", "2023-08-10"),
      filing("house", "Scott Scott", "Franklin", "FL18", "2025-03-18"),
      filing("house", "Scott Mr", "Franklin", "FL18", "2026-05-14"),
    ].map((entry) => resolver.resolve(entry));
    expect(new Set(identities.map((identity) => identity.filerKey))).toEqual(new Set(["member:F000472"]));
    expect(identities[0]).toEqual({
      filerKey: "member:F000472", memberId: "F000472", displayName: "Scott Franklin", identitySource: "legislators",
    });
  });

  test("keeps John and Debbie Dingell apart, and never picks John's father for his filing", () => {
    expect(resolver.resolve(filing("house", "John D.", "Dingell", "MI12", "2014-01-09")).memberId).toBe("D000355");
    expect(resolver.resolve(filing("house", "Debbie", "Dingell", "MI12", "2015-02-26")).memberId).toBe("D000624");
    expect(resolver.resolve(filing("house", "Debbie", "Dingell", "MI06", "2023-03-08")).memberId).toBe("D000624");
  });

  test("breaks a tie on name and seat by the most recent service", () => {
    const sameSeat = new MemberResolver({
      ...SNAPSHOT,
      legislators: [
        member("X000001", "John", "Dingell", [term("rep", "MI", 12, "1933-03-09", "1957-01-03")]),
        member("X000002", "John", "Dingell", [term("rep", "MI", 12, "1955-01-05", "2015-01-03")]),
      ],
    }, []);
    expect(sameSeat.resolve(filing("house", "John", "Dingell", "MI12", "2014-01-09")).memberId).toBe("X000002");
  });

  test("gives Tammy Duckworth one key across the House and the Senate", () => {
    const house = resolver.resolve(filing("house", "Tammy", "Duckworth", "IL08", "2015-05-01"));
    const senate = resolver.resolve(filing("senate", "Ladda Tammy", "Duckworth", null, "2020-05-01"));
    expect(house.filerKey).toBe("member:D000622");
    expect(senate.filerKey).toBe(house.filerKey);
  });

  test("tells Rick Scott from Tim Scott by given name", () => {
    expect(resolver.resolve(filing("senate", "Rick", "Scott", null, "2020-02-01")).memberId).toBe("S001217");
    expect(resolver.resolve(filing("senate", "TIM", "SCOTT", null, "2020-02-01")).memberId).toBe("S001184");
  });

  test("matches without accents and without credentials in the name", () => {
    expect(resolver.resolve(filing("house", "Luis V.", "Gutierrez", "IL04", "2014-01-30")).memberId).toBe("G000535");
    expect(resolver.resolve(filing("house", "Neal Patrick", "Dunn MD, FACS", "FL02", "2020-09-09")).memberId).toBe("D000628");
    expect(nameTokens("Dunn, MD, FACS")).toEqual(["dunn"]);
  });

  test("applies reviewed overrides for a married name and for non-members", () => {
    expect(resolver.resolve(filing("house", "Ashley", "Hinson Arenholz", "IA01", "2021-04-05"))).toEqual({
      filerKey: "member:H001091", memberId: "H001091", displayName: "Ashley Hinson", identitySource: "override",
    });
    expect(resolver.resolve(filing("house", "Richard B.", "Reisdorf", "MN01", "2022-04-18"))).toEqual({
      filerKey: "house|reisdorf|richard b", memberId: null, displayName: "Richard B. Reisdorf", identitySource: "non_member",
    });
  });

  test("leaves a filer who matches no one unresolved, under the filed name", () => {
    expect(resolver.resolve(filing("house", "PAT", "NOBODY", "OH03", "2024-01-01"))).toEqual({
      filerKey: "house|nobody|pat", memberId: null, displayName: "Pat Nobody", identitySource: "unresolved",
    });
  });

  test("fails an override its own filing no longer matches, and ignores one whose filing is absent", () => {
    const hinson = { ...filing("house", "Ashley", "Hinson Arenholz", "IA01", "2021-04-05"), docId: "20018521" };
    expect(resolver.staleOverrides([hinson])).toEqual([]);
    const corrected = { ...hinson, filerLast: "Hinson" };
    expect(resolver.staleOverrides([corrected]).map((entry) => entry.docId)).toEqual(["20018521"]);
    expect(resolver.staleOverrides([])).toEqual([]);
  });

  test("refuses an override naming a member it does not know", () => {
    const [first] = MEMBER_OVERRIDES;
    if (!first) throw new Error("no overrides");
    expect(() => new MemberResolver(SNAPSHOT, [{ ...first, memberId: "Z999999" }])).toThrow(/unknown member Z999999/);
  });
});

describe("events keyed on members", () => {
  const franklin = (docId: string, filerFirst: string, filingDate: string) => ({
    filing: filingFixture({ docId, filerFirst, filerLast: "Franklin", stateDistrict: "FL18", filingDate,
      availableAt: new Date(`${filingDate}T12:00:00.000Z`) }),
    trade: tradeFixture({ docId, filerFirst, filerLast: "Franklin", filingDate,
      availableAt: new Date(`${filingDate}T12:00:00.000Z`), transactionDate: "2025-02-10" }),
  });

  test("consolidates a repeat filed under another spelling of the member's name", () => {
    const original = franklin("20027834", "C. Scott", "2025-02-23");
    const repeat = franklin("20027995", "Scott Scott", "2025-03-18");
    const lake = identifyPoliticalRows([original.filing, repeat.filing], [original.trade, repeat.trade], resolver);
    const events = buildPoliticalTradeEvents(lake.trades, lake.filings);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ filerKey: "member:F000472", displayName: "Scott Franklin" });
    expect(JSON.parse(events[0]?.contributorRowIds ?? "[]")).toEqual(["20027834:0", "20027995:0"]);
  });

  test("gives non-members and unresolved filers trade rows but no events", () => {
    const staff = {
      filing: filingFixture({ docId: "8219483", filerFirst: "Ada Norah", filerLast: "Henriquez", stateDistrict: "PR00", filingDate: "2023-05-02" }),
      trade: tradeFixture({ docId: "8219483", filerFirst: "Ada Norah", filerLast: "Henriquez", filingDate: "2023-05-02" }),
    };
    const stranger = {
      filing: filingFixture({ docId: "20099999", filerFirst: "Pat", filerLast: "Nobody", stateDistrict: "OH03" }),
      trade: tradeFixture({ docId: "20099999", filerFirst: "Pat", filerLast: "Nobody" }),
    };
    const lake = identifyPoliticalRows([staff.filing, stranger.filing], [staff.trade, stranger.trade], resolver);
    expect(lake.trades.map((trade) => trade.identitySource)).toEqual(["non_member", "unresolved"]);
    expect(buildPoliticalTradeEvents(lake.trades, lake.filings)).toEqual([]);
  });
});

describe("identity audit checks", () => {
  const now = new Date("2026-09-21T00:00:00.000Z");
  const base = { chamber: "house" as const, docId: "1", filingDate: "2026-09-18", extractionStatus: "ok" as const };

  test("fails a member split across keys, an event from a non-member, and a stale override", () => {
    const report = auditPoliticalIntegrity({
      now,
      filings: [
        { ...base, docId: "1", memberId: "F000472", filerKey: "member:F000472", identitySource: "legislators" },
        { ...base, docId: "2", memberId: "F000472", filerKey: "house|franklin|scott", identitySource: "legislators" },
      ],
      trades: [],
      events: [{ eventId: "house:3:0", chamber: "house", sourceDocId: "3", contributorRowIds: "[\"3:0\"]", identitySource: "non_member" }],
      staleOverrides: ["house:8218652 Richard B. Reisdorf"],
    });
    const failed = report.findings.filter((entry) => entry.severity === "fail").map((entry) => entry.check);
    expect(failed).toEqual(expect.arrayContaining(["member_split", "non_member_events", "stale_overrides"]));
    expect(report.passed).toBe(false);
  });

  test("reports unresolved filers without failing the audit", () => {
    const report = auditPoliticalIntegrity({
      now,
      filings: [{ ...base, memberId: null, filerKey: "house|nobody|pat", identitySource: "unresolved" }],
      trades: [],
      events: [],
    });
    expect(report.findings).toEqual([expect.objectContaining({ check: "unresolved_filers", severity: "info", count: 1 })]);
    expect(report.passed).toBe(true);
  });
});

describe("congress-legislators files", () => {
  const current = Buffer.from(JSON.stringify([{
    id: { bioguide: "F000472" },
    name: { first: "C.", middle: "Scott", last: "Franklin", official_full: "Scott Franklin" },
    terms: [{ type: "rep", start: "2023-01-03", end: "2027-01-03", state: "FL", district: 18 }],
  }]));
  const historical = Buffer.from("[]");
  const commit = SNAPSHOT.commit;

  test("parses the upstream shape and records the bytes it used", () => {
    const snapshot = legislatorsFromFiles(commit, current, historical);
    expect(snapshot.legislators).toEqual([
      member("F000472", "C.", "Franklin", [term("rep", "FL", 18, "2023-01-03", "2027-01-03")], { middle: "Scott", officialFull: "Scott Franklin" }),
    ]);
    expect(snapshot.sha256.current).toMatch(/^[0-9a-f]{64}$/);
    expect(() => legislatorsFromFiles("73e2fcd", current, historical)).toThrow(/full SHA/);
  });

  test("falls back to the last cached commit when GitHub is unreachable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "congress-legislators-"));
    try {
      await mkdir(join(directory, commit), { recursive: true });
      await writeFile(join(directory, commit, "legislators-current.json"), current);
      await writeFile(join(directory, commit, "legislators-historical.json"), historical);
      await writeFile(join(directory, "latest"), commit);
      const offline: LegislatorsFetch = async () => { throw new Error("network down"); };
      const snapshot = await loadLegislators({ cacheDir: directory, fetcher: offline });
      expect(snapshot.commit).toBe(commit);
      expect(snapshot.legislators.map((entry) => entry.bioguide)).toEqual(["F000472"]);

      await rm(join(directory, "latest"));
      await expect(loadLegislators({ cacheDir: directory, fetcher: offline })).rejects.toThrow(/nothing is cached/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
