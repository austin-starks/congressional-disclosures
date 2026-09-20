export function isHelpRequest(args: readonly string[]): boolean {
  return args.length === 0 || args[0] === "help" || args[0] === "--help" || args[0] === "-h";
}
