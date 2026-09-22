#!/usr/bin/env node

const path = require("node:path");

const {
  LocalCache,
  MemberResolver,
  SQLitePoliticalRepository,
  SenateEfdSession,
  fetchSenateMedia,
  loadLegislators,
  parseSlashDate,
  senateReportKind,
  syncPoliticalDisclosures,
} = require("../dist");

async function main() {
  const year = Number(process.argv[2] ?? new Date().getUTCFullYear());
  const outputRoot = path.resolve(process.argv[3] ?? ".live-senate-canary");
  const session = await SenateEfdSession.open(true);
  const reports = await session.searchPeriodicTransactionReports(`01/01/${year}`);
  const report = reports.find((candidate) =>
    senateReportKind(candidate.reportPath) === "electronic" &&
    parseSlashDate(candidate.submittedDate)?.startsWith(`${year}-`)
  );
  if (!report) throw new Error(`No electronic Senate PTR found for ${year}`);
  const submitted = parseSlashDate(report.submittedDate);
  if (!submitted) throw new Error("Selected Senate PTR has no submitted date");
  const resolver = new MemberResolver(await loadLegislators({ cacheDir: path.join(outputRoot, "legislators") }));
  const repository = new SQLitePoliticalRepository(path.join(outputRoot, "senate.sqlite"));
  try {
    const summary = await syncPoliticalDisclosures({
      repository,
      resolver,
      cache: new LocalCache(path.join(outputRoot, "cache")),
      sinceYear: year,
      year,
      chamber: "senate",
      acceptSenateTerms: true,
      now: new Date(`${submitted}T12:00:00.000Z`),
      sources: {
        senate: {
          search: async () => [report],
          fetchReportHtml: (reportPath) => session.fetchReportHtml(reportPath),
          fetchMedia: fetchSenateMedia,
        },
      },
    });
    const snapshot = await repository.snapshot();
    if (summary.succeeded !== 1 || snapshot.filings.length !== 1 || snapshot.trades.length === 0) {
      throw new Error(`Live Senate canary did not produce rows: ${JSON.stringify(summary)}`);
    }
    if (!snapshot.filings[0].memberId) {
      throw new Error(`Live Senate filer ${snapshot.filings[0].filerFirst} ${snapshot.filings[0].filerLast} matched no senator`);
    }
    process.stdout.write(`${JSON.stringify({
      reportId: snapshot.filings[0].docId,
      filings: snapshot.filings.length,
      trades: snapshot.trades.length,
      events: snapshot.events.length,
      auditPassed: summary.audit?.passed ?? false,
    }, null, 2)}\n`);
  } finally {
    await repository.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
