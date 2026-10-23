// Plain ESM so Electron's main process and the server enforce exactly the same lease protocol.
export {
  acquireDataDirLease,
  acquireDataDirLeaseForProcess,
  DataDirLeaseError,
} from "../shared/client/data-dir-lease.mjs";

export type {
  DataDirLease,
  DelegatedDataDirLease,
  OwnedDataDirLease,
} from "../shared/client/data-dir-lease.mjs";
