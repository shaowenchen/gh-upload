import { Octokit } from "@octokit/rest";
import { config } from "../config.js";
import { Buffer } from "node:buffer";

const [REPO_OWNER, REPO_NAME] = config.github.repo.split("/");

interface RepoInfo {
  name: string;
  defaultBranch: string;
}

export class GitHubService {
  private octokit: Octokit;
  private branch: string;
  private commitEmail: string;
  private commitName: string;
  private isOrg: boolean | null = null;

  constructor() {
    this.octokit = new Octokit({ auth: config.github.token });
    this.branch = config.github.branch;
    this.commitEmail = config.github.commitEmail;
    this.commitName = config.github.commitName;
  }

  private async checkIsOrg(): Promise<boolean> {
    if (this.isOrg !== null) return this.isOrg;
    try {
      await this.octokit.rest.orgs.get({ org: REPO_OWNER });
      this.isOrg = true;
    } catch {
      this.isOrg = false;
    }
    return this.isOrg;
  }

  async getOrCreateRepo(): Promise<RepoInfo> {
    const isOrg = await this.checkIsOrg();

    try {
      const { data: repo } = await this.octokit.rest.repos.get({
        owner: REPO_OWNER,
        repo: REPO_NAME,
      });
      return { name: repo.name, defaultBranch: repo.default_branch };
    } catch {
      return this.createRepo(isOrg);
    }
  }

  private async createRepo(isOrg: boolean): Promise<RepoInfo> {
    const params = {
      name: REPO_NAME,
      private: false,
      auto_init: false,
      default_branch: this.branch,
    } as const;

    const { data: repo } = isOrg
      ? await this.octokit.rest.repos.createInOrg({ ...params, org: REPO_OWNER })
      : await this.octokit.rest.repos.createForAuthenticatedUser(params);

    return { name: repo.name, defaultBranch: repo.default_branch };
  }

  async getBranchSize(repo: RepoInfo, branch: string): Promise<number> {
    try {
      await this.octokit.rest.repos.getBranch({
        owner: REPO_OWNER,
        repo: repo.name,
        branch,
      });
      const { data: contents } = await this.octokit.rest.repos.getContent({
        owner: REPO_OWNER,
        repo: repo.name,
        path: "",
        ref: branch,
      });
      if (Array.isArray(contents)) {
        return contents.reduce((sum, c) => (c.type === "file" ? sum + c.size : sum), 0);
      }
      return 0;
    } catch {
      // Branch doesn't exist, create it from default branch
      const defaultBranch = repo.defaultBranch || "main";
      const { data: branchRef } = await this.octokit.rest.repos.getBranch({
        owner: REPO_OWNER,
        repo: repo.name,
        branch: defaultBranch,
      });
      await this.octokit.rest.git.createRef({
        owner: REPO_OWNER,
        repo: repo.name,
        ref: `refs/heads/${branch}`,
        sha: branchRef.commit.sha,
      });
      return 0;
    }
  }

  async listFiles(repo: RepoInfo) {
    try {
      const { data: contents } = await this.octokit.rest.repos.getContent({
        owner: REPO_OWNER,
        repo: repo.name,
        path: "",
        ref: this.branch,
      });
      return Array.isArray(contents) ? contents : [];
    } catch {
      return [];
    }
  }

  async uploadContent(repoPath: string, content: Buffer): Promise<string> {
    const repo = await this.getOrCreateRepo();
    await this.octokit.rest.repos.createOrUpdateFileContents({
      owner: REPO_OWNER,
      repo: repo.name,
      path: repoPath,
      message: this.commitName,
      content: content.toString("base64"),
      branch: this.branch,
      committer: { name: this.commitName, email: this.commitEmail },
    });
    return `${REPO_OWNER}/${repo.name}/${this.branch}/${repoPath}`;
  }

  async downloadFile(repo: RepoInfo, fileName: string): Promise<Buffer> {
    const { data } = await this.octokit.rest.repos.getContent({
      owner: REPO_OWNER,
      repo: repo.name,
      path: fileName,
      ref: this.branch,
    });
    // Single file response
    if (!Array.isArray(data) && "content" in data && data.content) {
      return Buffer.from(data.content, "base64");
    }
    throw new Error(`Not a file: ${fileName}`);
  }

  async deleteFile(repo: RepoInfo, path: string): Promise<void> {
    const { data: file } = await this.octokit.rest.repos.getContent({
      owner: REPO_OWNER,
      repo: repo.name,
      path,
      ref: this.branch,
    });
    if (Array.isArray(file) || !("sha" in file)) return;
    await this.octokit.rest.repos.deleteFile({
      owner: REPO_OWNER,
      repo: repo.name,
      path,
      message: `Delete file ${path}`,
      sha: file.sha,
      branch: this.branch,
      committer: { name: this.commitName, email: this.commitEmail },
    });
  }

  async deleteRepo(repo: RepoInfo): Promise<void> {
    await this.octokit.rest.repos.delete({
      owner: REPO_OWNER,
      repo: repo.name,
    });
  }
}