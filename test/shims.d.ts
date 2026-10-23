declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
}

declare module "node:sqlite" {
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): {
      get(...args: unknown[]): unknown;
      all(...args: unknown[]): unknown[];
    };
  }
}
