/// <reference types="vite/client" />

declare module "virtual:records" {
  const records: import("./lib/records-types.ts").Records;
  export default records;
}
