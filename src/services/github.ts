import { Octokit } from "@octokit/rest";
import { config } from "../config.js";
import { Buffer } from "node:buffer";

const REPO_NAME = config.github.repo;

interface RepoInfo {
  name: string;
  defaultBranch: string;
}

export class GitHubService {
  private octokit: Octokit;
  private owner: string;
  private branch: string;
  private commitEmail: string;
  private commitName: string;

  constructor() {
    this.octokit = new Octokit({ auth: config.github.token });
    this.owner = config.github.owner;
    this.branch = config.github.branch;
    this.commitEmail = config.github.commitEmail;
    this.commitName = config.github.commitName;
  }

  async getOrCreateRepo(): Promise<RepoInfo> {
    const repos = await this.octokit.rest.repos.listForOrg({
      org: this.owner,
      per_page: 100,
    });
    for (const r of repos.data) {
      if (r.name === REPO_NAME) {
        return { name: r.name, defaultBranch: r.default_branch || this.branch };
      }
    }
    return this.createRepo();
  }

  private async createRepo(): Promise<RepoInfo> {
    const { data: repo } = await this.octokit.rest.repos.createInOrg({
      org: this.owner,
      name: REPO_NAME,
      private: false,
      auto_init: false,
      default_branch: this.branch,
    });
    return { name: repo.name, defaultBranch: repo.default_branch };
  }

  async getBranchSize(repo: RepoInfo, branch: string): Promise<number> {
    try {
      await this.octokit.rest.repos.getBranch({
        owner: this.owner,
        repo: repo.name,
        branch,
      });
      const { data: contents } = await this.octokit.rest.repos.getContent({
        owner: this.owner,
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
        owner: this.owner,
        repo: repo.name,
        branch: defaultBranch,
      });
      await this.octokit.rest.git.createRef({
        owner: this.owner,
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
        owner: this.owner,
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
      owner: this.owner,
      repo: repo.name,
      path: repoPath,
      message: this.commitName,
      content: content.toString("base64"),
      branch: this.branch,
      committer: { name: this.commitName, email: this.commitEmail },
    });
    return `${this.owner}/${repo.name}/${this.branch}/${repoPath}`;
  }

  async downloadFile(repo: RepoInfo, fileName: string): Promise<Buffer> {
    const { data } = await this.octokit.rest.repos.getContent({
      owner: this.owner,
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
      owner: this.owner,
      repo: repo.name,
      path,
      ref: this.branch,
    });
    if (Array.isArray(file) || !("sha" in file)) return;
    await this.octokit.rest.repos.deleteFile({
      owner: this.owner,
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
      owner: this.owner,
      repo: repo.name,
    });
  }
}