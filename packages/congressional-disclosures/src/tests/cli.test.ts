import { isHelpRequest } from "../cliArgs";

describe("CLI help", () => {
  it("accepts the documented direct help aliases", () => {
    const requests: readonly (readonly string[])[] = [[], ["help"], ["--help"], ["-h"]];
    for (const args of requests) expect(isHelpRequest(args)).toBe(true);
  });

  it("does not treat real commands as help", () => {
    expect(isHelpRequest(["doctor"])).toBe(false);
    expect(isHelpRequest(["sync", "--help"])).toBe(false);
  });
});
