export interface Config {
  port: number;
  host: string;
  github: {
    token: string;
    owner: string;
    repo: string;
    branch: string;
    commitEmail: string;
    commitName: string;
  };
  downloadUrls: string[];
}

function loadConfig(): Config {
  return {
    port: parseInt(process.env.PORT || "3000", 10),
    host: process.env.HOST || "0.0.0.0",
    github: {
      token: process.env.GITHUB_TOKEN || "",
      owner: process.env.GITHUB_OWNER || "uploadbases",
      repo: process.env.GITHUB_REPO || "cdn0",
      branch: process.env.GITHUB_BRANCH || "raw",
      commitEmail: process.env.GITHUB_COMMIT_EMAIL || "auto@auto.com",
      commitName: process.env.GITHUB_COMMIT_NAME || "none",
    },
    downloadUrls: (process.env.DOWNLOAD_URLS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

export const config: Config = loadConfig();