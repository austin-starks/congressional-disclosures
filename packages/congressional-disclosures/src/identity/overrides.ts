import type { MemberOverride } from "./types";

/**
 * Reviewed filer identities the matching rules cannot decide. Each entry cites the
 * filing that proves it; `memberId: null` records someone who never served.
 */
export const MEMBER_OVERRIDES: readonly MemberOverride[] = [
  {
    chamber: "house",
    docId: "20018521",
    filerFirst: "Ashley",
    filerLast: "Hinson Arenholz",
    stateDistrict: "IA01",
    memberId: "H001091",
    reason: "Rep. Ashley Hinson filing under her married name",
    evidence: "https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2021/20018521.pdf",
  },
  {
    chamber: "house",
    docId: "8219483",
    filerFirst: "Ada Norah",
    filerLast: "Henriquez",
    stateDistrict: "PR00",
    memberId: null,
    reason: "House employee (Armed Services Committee); the form is signed Natalia Henriquez, Officer or Employee",
    evidence: "https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2023/8219483.pdf",
  },
  {
    chamber: "house",
    docId: "8218652",
    filerFirst: "Richard B.",
    filerLast: "Reisdorf",
    stateDistrict: "MN01",
    memberId: null,
    reason: "a candidate's campaign notice (threshold not exceeded), not a trade report",
    evidence: "https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2022/8218652.pdf",
  },
];
