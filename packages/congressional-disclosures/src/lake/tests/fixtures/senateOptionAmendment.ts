import type { SenateReportSource } from "../../normalize";
import type { SenateElectronicTransaction } from "../../../sources/senate";

export const initialReport = {
  reportId: "11111111-1111-4111-8111-111111111111",
  firstName: "Jamie",
  lastName: "Example",
  submittedDate: "06/12/2024",
  reportTitle: "Periodic Transaction Report for 06/10/2024",
  sourceUrl: "https://efdsearch.senate.gov/search/view/ptr/11111111-1111-4111-8111-111111111111/",
  rawArchiveKey: "raw/11/initial.html",
  rawSha256: "1".repeat(64),
  processedAt: new Date("2024-06-13T12:00:00.000Z"),
} satisfies SenateReportSource;

export const initialTransaction = {
  rowNumber: 1,
  transactionDate: "06/03/2024",
  owner: "Spouse",
  ticker: "NVDA",
  assetName: "NVIDIA Corporation call option",
  assetType: "Stock Option",
  transactionType: "Sale (Partial)",
  amount: "$50,001 - $100,000",
  comment: "Partial sale",
} satisfies SenateElectronicTransaction;

export const initialTransactions = [initialTransaction] satisfies readonly SenateElectronicTransaction[];

export const amendedReport = {
  ...initialReport,
  reportId: "22222222-2222-4222-8222-222222222222",
  submittedDate: "06/20/2024",
  reportTitle: "Periodic Transaction Report for 06/10/2024 (Amendment 1)",
  sourceUrl: "https://efdsearch.senate.gov/search/view/ptr/22222222-2222-4222-8222-222222222222/",
  rawArchiveKey: "raw/22/amended.html",
  rawSha256: "2".repeat(64),
  processedAt: new Date("2024-06-21T12:00:00.000Z"),
} satisfies SenateReportSource;

export const amendedTransactions = [{
  ...initialTransaction,
  amount: "$100,001 - $250,000",
  comment: "Corrected amount range",
}] satisfies readonly SenateElectronicTransaction[];
