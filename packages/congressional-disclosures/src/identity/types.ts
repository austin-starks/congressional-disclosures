import type { PoliticalChamber } from "../lake/types";

/**
 * How a filing's filer was identified. `legislators` and `override` name a member of
 * Congress; `non_member` is a reviewed filer who never served (committee staff, a
 * candidate's notice); `unresolved` matched no one and waits for an override.
 */
export const IDENTITY_SOURCES = ["legislators", "override", "non_member", "unresolved"] as const;
export type IdentitySource = (typeof IDENTITY_SOURCES)[number];

/** Identity sources whose trades count as a member's and reach `political_trade_events`. */
export const MEMBER_IDENTITY_SOURCES: ReadonlySet<IdentitySource> = new Set(["legislators", "override"]);

export interface FilerIdentity {
  /** `member:<bioguide>` for a member (one key across both chambers), else the normalised filed name. */
  filerKey: string;
  /** Bioguide ID, or null when the filer is not a member. */
  memberId: string | null;
  /** The member's official name, or the filed name title-cased. */
  displayName: string;
  identitySource: IdentitySource;
}

/** The fields of a filing the resolver reads. */
export interface IdentityInput {
  chamber: PoliticalChamber;
  filerFirst: string;
  filerLast: string;
  stateDistrict: string | null;
  filingDate: string;
}

export interface LegislatorTerm {
  type: "rep" | "sen";
  start: string;
  end: string;
  state: string;
  /** House district; 0 is at-large; null for the Senate. */
  district: number | null;
}

export interface Legislator {
  bioguide: string;
  first: string;
  middle: string | null;
  nickname: string | null;
  last: string;
  officialFull: string | null;
  terms: LegislatorTerm[];
}

/** The congress-legislators files a resolution used, so every identity can be reproduced. */
export interface LegislatorsSnapshot {
  /** Full commit SHA on the upstream `gh-pages` branch. */
  commit: string;
  sha256: { current: string; historical: string };
  legislators: Legislator[];
}

/**
 * A reviewed decision the rules cannot make. `memberId: null` records a non-member.
 * Every entry names the filing that proves it (`docId`); when that filing is present
 * and no longer matches the entry, the audit fails, so the list cannot rot.
 */
export interface MemberOverride {
  chamber: PoliticalChamber;
  /** The filing that proves the entry. */
  docId: string;
  filerFirst: string;
  filerLast: string;
  stateDistrict: string | null;
  memberId: string | null;
  reason: string;
  evidence: string;
}
