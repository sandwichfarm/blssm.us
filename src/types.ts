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

/** Access control configuration from config/access.json */
export interface AccessConfig {
  /** true = public mode (anyone can publish unless on blocklist)
   *  false = private mode (only allowlisted pubkeys can publish) */
  public: boolean;
  /** Hex pubkeys always allowed (in public+payments mode, also skip payment) */
  allowlist: string[];
  /** Hex pubkeys always denied (in public mode; ignored in private mode) */
  blocklist: string[];
  /** true = public+payments mode (unlisted pubkeys routed to payment). Only meaningful when public=true. Default: false */
  payments?: boolean;
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

/**
 * A single Cashu mint entry in operator payment config.
 * Minimal for v1; future phases may add optional per-mint fields (e.g. weight, label).
 */
export interface MintEntry {
  /** HTTPS URL of the Cashu mint */
  url: string;
}

/**
 * Per-action payment amounts in satoshis.
 * 0 = free for that action (no 402 issued).
 * Delete is always free and excluded by design (encourages storage cleanup).
 */
export interface PaymentAmounts {
  /** Satoshis required to upload a blob; 0 = free */
  upload: number;
  /** Satoshis required to mirror a blob; 0 = free */
  mirror: number;
}

/**
 * Operator configuration from config/payment.json.
 * NOT the same as PaymentInfo (which is the 402 response format sent to clients).
 * An empty mints array disables payments entirely, even if amounts are set.
 */
export interface PaymentConfig {
  /** Cashu mints accepted for payment verification */
  mints: MintEntry[];
  /** Per-action amounts in satoshis */
  amounts: PaymentAmounts;
}

/** USD-basis pricing parameters from config/payment.toml */
export interface PricingConfig {
  /** USD cost per gigabyte of storage */
  cost_per_gb_usd: number;
  /** Profit margin as decimal (0.20 = 20%) */
  profit_margin_pct: number;
  /** Slippage premium as decimal (0.05 = 5%) */
  slippage_premium_pct: number;
}

/** Result of Cashu proof validation — discriminated union on `valid` */
export type ValidationResult =
  | { valid: true }
  | {
      valid: false;
      /** Error reason for X-Reason header */
      reason: string;
      /** HTTP status override (400 default, 503 for mint unreachable) */
      status?: number;
    };

/**
 * Cache TTL configuration from config/cache.json.
 * All values are in milliseconds internally (JSON values are in seconds).
 * Missing config/cache.json defaults to 60 seconds for all caches.
 */
export interface CacheConfig {
  /** TTL in ms for the access config cache (config/access.json) */
  accessTtl: number;
  /** TTL in ms for the payment config cache (config/payment.json) */
  paymentTtl: number;
  /** TTL in ms for the blocked hashes cache (config/blocked.json) */
  blockedTtl: number;
}
