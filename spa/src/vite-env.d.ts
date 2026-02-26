/// <reference types="svelte" />
/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Show allowlist pubkeys on the SPA when server is private */
  readonly VITE_SHOW_ALLOWLIST: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
