export interface Config {
  port: number;
  host: string;
  adminToken: string;
  github: {
    token: string;
    repo: string;
    branch: string;
    /** REST API base; override for GitHub Enterprise. */
    apiBase: string;
    commitEmail: string;
    commitName: string;
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
    adminToken: process.env.ADMIN_TOKEN || "",
    github: {
      token: process.env.GITHUB_TOKEN || "",
      repo: process.env.GITHUB_REPO || "uploadbases/cdn0",
      branch: process.env.GITHUB_BRANCH || "raw",
      apiBase: process.env.GITHUB_API_BASE || "https://api.github.com",
      commitEmail: process.env.GITHUB_COMMIT_EMAIL || "auto@auto.com",
      commitName: process.env.GITHUB_COMMIT_NAME || "none",
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