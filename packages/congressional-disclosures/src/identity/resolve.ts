import { MEMBER_OVERRIDES } from "./overrides";
import type {
  FilerIdentity,
  IdentityInput,
  Legislator,
  LegislatorsSnapshot,
  LegislatorTerm,
  MemberOverride,
} from "./types";

/**
 * Words the official indexes attach to names that are not part of them: honorifics
 * ("Scott Mr", "Donald Sternoff Honorable"), suffixes ("King, Jr.") and credentials
 * ("Dunn, MD, FACS").
 */
const NOISE_WORDS = new Set([
  "mr", "mrs", "ms", "dr", "hon", "honorable", "the", "jr", "sr", "ii", "iii", "iv", "md", "facs", "phd", "dds", "esq",
]);

/** Accent-folded, lower-case name words with index noise removed. "Gutiérrez" and "GUTIERREZ" agree. */
export function nameTokens(text: string): string[] {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z\- ]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 0 && !NOISE_WORDS.has(word));
}

/** The key a filer gets when no member is identified: the filed name, normalised. */
export function nameKey(filing: Pick<IdentityInput, "chamber" | "filerFirst" | "filerLast">): string {
  return `${filing.chamber}|${nameTokens(filing.filerLast).join(" ")}|${nameTokens(filing.filerFirst).join(" ")}`;
}

function titleCase(text: string): string {
  return text
    .trim()
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

/** "Richard B. Reisdorf" from "RICHARD B." and "REISDORF". */
export function filedDisplayName(filing: Pick<IdentityInput, "filerFirst" | "filerLast">): string {
  return titleCase(`${filing.filerFirst} ${filing.filerLast.replace(/\s*,\s*/g, " ")}`);
}

function memberDisplayName(member: Legislator): string {
  return member.officialFull ?? `${member.first} ${member.last}`;
}

function memberIdentity(member: Legislator, source: "legislators" | "override"): FilerIdentity {
  return { filerKey: `member:${member.bioguide}`, memberId: member.bioguide, displayName: memberDisplayName(member), identitySource: source };
}

function unidentified(filing: IdentityInput, source: "non_member" | "unresolved"): FilerIdentity {
  return { filerKey: nameKey(filing), memberId: null, displayName: filedDisplayName(filing), identitySource: source };
}

function overrideKey(entry: Pick<MemberOverride, "chamber" | "filerFirst" | "filerLast" | "stateDistrict">): string {
  return `${nameKey(entry)}|${entry.stateDistrict ?? ""}`;
}

/** One side's last name ends with the other's words: "Wasserman Schultz" and "Schultz", "Van Hollen" and "Van Hollen". */
function lastNamesAgree(filed: readonly string[], member: readonly string[]): boolean {
  if (filed.length === 0 || member.length === 0) return false;
  const [shorter, longer] = filed.length <= member.length ? [filed, member] : [member, filed];
  const tail = longer.slice(longer.length - shorter.length);
  return tail.every((word, index) => word === shorter[index]);
}

function givenNamesAgree(filed: readonly string[], member: Legislator): boolean {
  const given = nameTokens([member.first, member.middle, member.nickname].filter(Boolean).join(" "));
  return filed.some((word) => given.some((name) => name === word || name.slice(0, 3) === word.slice(0, 3)));
}

interface Candidate {
  member: Legislator;
  /** The last day of matching service on or before the filing. */
  lastServed: string;
}

interface Seat {
  type: LegislatorTerm["type"];
  state: string | null;
  district: number | null;
}

function seatOf(filing: IdentityInput): Seat {
  if (filing.chamber === "senate" || !filing.stateDistrict) {
    return { type: filing.chamber === "senate" ? "sen" : "rep", state: null, district: null };
  }
  const state = filing.stateDistrict.slice(0, 2).toUpperCase();
  const digits = filing.stateDistrict.slice(2);
  return { type: "rep", state, district: /^\d+$/.test(digits) ? Number(digits) : null };
}

/**
 * Deterministic filer identity against congress-legislators. Every filing is matched
 * against everyone who had served in its seat (House) or chamber (Senate) by the filing
 * date; members keep filing after they leave office, so there is no window after a term
 * ends. Ties break on given names, then on the most recent service. Nothing is matched
 * by similarity: if the rules cannot decide, the filing is `unresolved` until a reviewed
 * override decides it.
 */
export class MemberResolver {
  readonly legislatorsCommit: string;
  private readonly byLastWord = new Map<string, Legislator[]>();
  private readonly byBioguide = new Map<string, Legislator>();
  private readonly overrides = new Map<string, MemberOverride>();

  constructor(snapshot: LegislatorsSnapshot, overrides: readonly MemberOverride[] = MEMBER_OVERRIDES) {
    this.legislatorsCommit = snapshot.commit;
    for (const member of snapshot.legislators) {
      this.byBioguide.set(member.bioguide, member);
      const last = nameTokens(member.last);
      const lastWord = last[last.length - 1];
      if (lastWord === undefined) continue;
      this.byLastWord.set(lastWord, [...(this.byLastWord.get(lastWord) ?? []), member]);
    }
    for (const entry of overrides) {
      if (entry.memberId !== null && !this.byBioguide.has(entry.memberId)) {
        throw new Error(`member override for ${entry.filerFirst} ${entry.filerLast} names unknown member ${entry.memberId}`);
      }
      this.overrides.set(overrideKey(entry), entry);
    }
  }

  resolve(filing: IdentityInput): FilerIdentity {
    const override = this.overrides.get(overrideKey(filing));
    if (override) {
      const member = override.memberId === null ? undefined : this.byBioguide.get(override.memberId);
      return member ? memberIdentity(member, "override") : unidentified(filing, "non_member");
    }
    const matches = this.match(filing);
    return matches.length === 1 && matches[0] ? memberIdentity(matches[0], "legislators") : unidentified(filing, "unresolved");
  }

  /**
   * Overrides whose proving filing is in `filings` but no longer matches the entry (the
   * index corrected a name, say): a stale entry, which the audit fails. An entry whose
   * filing is absent is not judged, so a partial sync never fails on it.
   */
  staleOverrides(filings: ReadonlyArray<IdentityInput & { docId: string }>): MemberOverride[] {
    const byDoc = new Map(filings.map((filing) => [`${filing.chamber}:${filing.docId}`, filing]));
    return [...this.overrides.entries()]
      .filter(([key, entry]) => {
        const filing = byDoc.get(`${entry.chamber}:${entry.docId}`);
        return filing !== undefined && overrideKey(filing) !== key;
      })
      .map(([, entry]) => entry);
  }

  private candidates(filing: IdentityInput, seat: Seat, filed: readonly string[], exactLast: boolean): Candidate[] {
    const lastWord = filed[filed.length - 1];
    if (lastWord === undefined) return [];
    const out: Candidate[] = [];
    for (const member of this.byLastWord.get(lastWord) ?? []) {
      const last = nameTokens(member.last);
      if (exactLast ? last.join(" ") !== filed.join(" ") : !lastNamesAgree(filed, last)) continue;
      let lastServed: string | null = null;
      for (const term of member.terms) {
        if (term.type !== seat.type || term.start > filing.filingDate) continue;
        if (seat.state !== null && term.state !== seat.state) continue;
        if (seat.district !== null && term.district !== null && term.district !== seat.district) continue;
        const served = term.end < filing.filingDate ? term.end : filing.filingDate;
        if (lastServed === null || served > lastServed) lastServed = served;
      }
      if (lastServed !== null) out.push({ member, lastServed });
    }
    return out;
  }

  private match(filing: IdentityInput): Legislator[] {
    const filed = nameTokens(filing.filerLast);
    const seat = seatOf(filing);
    let candidates = this.candidates(filing, seat, filed, false);
    // Some House index rows carry a stale district after redistricting.
    if (candidates.length === 0 && seat.district !== null) {
      candidates = this.candidates(filing, { ...seat, district: null }, filed, true);
    }
    if (candidates.length <= 1) return candidates.map((candidate) => candidate.member);

    const given = nameTokens(filing.filerFirst);
    const named = candidates.filter((candidate) => givenNamesAgree(given, candidate.member));
    const narrowed = named.length > 0 ? named : candidates;
    if (narrowed.length === 1) return narrowed.map((candidate) => candidate.member);

    const latest = narrowed.reduce((best, candidate) => (candidate.lastServed > best ? candidate.lastServed : best), "");
    return narrowed.filter((candidate) => candidate.lastServed === latest).map((candidate) => candidate.member);
  }
}
