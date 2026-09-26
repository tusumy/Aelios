import "./types";

declare module "./types" {
  interface Env {
    /** Claude setup-token. Prefixless /v1/messages can go directly to Anthropic. */
    CLAUDE_OAUTH_TOKEN?: string;
    /** Set to false to disable the Claude Code system prefix on the OAuth route. */
    CLOAK?: string;
    /** Codex ChatGPT OAuth refresh token. */
    CODEX_REFRESH_TOKEN?: string;
    /** Optional full Codex auth.json; refresh_token is extracted from it. */
    CODEX_AUTH_JSON?: string;
    /** Optional ChatGPT account id; otherwise inferred from the access-token JWT. */
    CODEX_ACCOUNT_ID?: string;
  }
}

export {};
