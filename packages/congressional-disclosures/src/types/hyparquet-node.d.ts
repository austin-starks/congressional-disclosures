declare module "hyparquet/src/node.js" {
  export * from "hyparquet";
  import type { AsyncBuffer } from "hyparquet";

  export function asyncBufferFromFile(filename: string): Promise<AsyncBuffer>;
}
