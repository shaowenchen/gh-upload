export interface Config {
  port: number;
  host: string;
  github: {
    token: string;
    repo: string;
    branch: string;
    /** REST API base; override for GitHub Enterprise. */
    apiBase: string;
    commitEmail: string;
    commitName: string;
    /** Visibility to give a repository this service creates. */
    repoPrivate: boolean;
  };
  downloadUrls: string[];
  /** HMAC secret for signed download links; empty disables signing. */
  downloadSecret: string;
  /** Lifetime of a signed download link, in seconds. */
  downloadTtlSeconds: number;
}

function loadConfig(): Config {
  return {
    port: parseInt(process.env.PORT || "3000", 10),
    host: process.env.HOST || "0.0.0.0",
    github: {
      token: process.env.GITHUB_TOKEN || "",
      repo: process.env.GITHUB_REPO || "uploadbases/cdn0",
      branch: process.env.GITHUB_BRANCH || "raw",
      apiBase: process.env.GITHUB_API_BASE || "https://api.github.com",
      commitEmail: process.env.GITHUB_COMMIT_EMAIL || "auto@auto.com",
      commitName: process.env.GITHUB_COMMIT_NAME || "none",
      // Private by default: a repository this service creates holds whatever
      // was uploaded to it, and nothing about an upload is a decision to
      // publish. Only an explicit "false" opens it up, so a typo or an empty
      // value fails closed rather than exposing the contents.
      repoPrivate: (process.env.GITHUB_REPO_PRIVATE || "true").toLowerCase() !== "false",
    },
    downloadUrls: (process.env.DOWNLOAD_URLS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    downloadSecret: process.env.DOWNLOAD_SECRET || "",
    downloadTtlSeconds: Math.max(1, parseInt(process.env.DOWNLOAD_TTL || "604800", 10) || 604800),
  };
}

export const config: Config = loadConfig();