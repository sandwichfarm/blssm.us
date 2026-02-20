/** Blossom BlobDescriptor as defined in BUD-01 */
export interface BlobDescriptor {
  url: string;
  sha256: string;
  size: number;
  type?: string;
  uploaded: number;
  /** NIP-94 metadata fields (BUD-08) — array of [key, value] pairs */
  nip94?: string[][];
}

/** Nostr event structure for kind 24242 auth */
export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

/** Stored blob metadata */
export interface BlobMeta {
  sha256: string;
  size: number;
  type: string;
  uploaded: number;
  owners: string[];
  /** NIP-94 metadata from uploader — array of [key, value] pairs */
  nip94?: string[][];
}

/** Per-pubkey blob index entry */
export interface BlobIndexEntry {
  sha256: string;
  size: number;
  type: string;
  uploaded: number;
}

/** Report stored for BUD-09 */
export interface StoredReport {
  reports: NostrEvent[];
}

/** Blocked content config */
export interface BlockedConfig {
  hashes: string[];
}

/** Server configuration from environment */
export interface Config {
  /** Storage zone password (FTP & API Access → Password) */
  storagePassword: string;
  /** Storage zone hostname (FTP & API Access → Hostname, e.g. storage.bunnycdn.com) */
  storageHostname: string;
  /** Storage zone username (FTP & API Access → Username) */
  storageUsername: string;
  /** Public CDN hostname for blob URLs (e.g. myzone.b-cdn.net) */
  cdnHostname: string;
  /** Public Blossom server URL for auth server tag validation */
  serverUrl: string;
  maxUploadSize: number;
  /** SPA storage zone password */
  spaStoragePassword?: string;
  /** SPA storage zone hostname (e.g. storage.bunnycdn.com) */
  spaStorageHostname?: string;
  /** SPA storage zone username */
  spaStorageUsername?: string;
}

/** Auth result from Nostr event validation */
export interface AuthResult {
  authorized: boolean;
  pubkey?: string;
  error?: string;
  event?: NostrEvent;
}

/** Payment info for BUD-07 402 responses */
export interface PaymentInfo {
  amount: number;
  unit: string;
  /** LNURL or Lightning address */
  lnurl?: string;
}
