import { Octokit } from "@octokit/rest";
import { config } from "../config.js";
import { Buffer } from "node:buffer";

const [REPO_OWNER, REPO_NAME] = config.github.repo.split("/");

/** How long to trust a cached repo lookup before hitting the API again. */
const REPO_CACHE_TTL_MS = 60_000;

/** Attempts to land a commit before giving up on ref contention. */
const COMMIT_MAX_ATTEMPTS = 5;

export interface RepoInfo {
  name: string;
  defaultBranch: string;
}

export interface FileToCommit {
  path: string;
  /** Blob sha returned by createBlob. */
  sha: string;
}

export interface TreeEntry {
  path: string;
  sha: string;
  size: number;
}

export class GitHubService {
  private octokit: Octokit;
  private branch: string;
  private commitEmail: string;
  private commitName: string;
  private isOrg: boolean | null = null;
  private repoPromise: Promise<RepoInfo> | null = null;
  private repoCachedAt = 0;

  constructor() {
    this.octokit = new Octokit({
      auth: config.github.token,
      baseUrl: config.github.apiBase,
    });
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

  /**
   * Resolve the target repo, caching the result briefly. A chunked upload makes
   * many calls in quick succession, and each one re-running the org probe and
   * repo lookup costs two API requests for an answer that cannot have changed.
   */
  async getOrCreateRepo(): Promise<RepoInfo> {
    const fresh =
      this.repoPromise !== null && Date.now() - this.repoCachedAt < REPO_CACHE_TTL_MS;
    if (fresh) return this.repoPromise as Promise<RepoInfo>;

    this.repoCachedAt = Date.now();
    this.repoPromise = this.resolveRepo().catch((err) => {
      // Never cache a failure — let the next caller retry.
      this.repoPromise = null;
      throw err;
    });
    return this.repoPromise;
  }

  private async resolveRepo(): Promise<RepoInfo> {
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

  /**
   * Write a blob and return its sha.
   *
   * Blobs are content-addressed and attach to no ref, so chunks can be uploaded
   * concurrently without contending for the branch ref — and re-sending a chunk
   * of identical content resolves to the same object instead of a second write.
   * Only commitFiles touches the ref.
   */
  async createBlob(content: Buffer): Promise<string> {
    const repo = await this.getOrCreateRepo();
    const { data } = await this.octokit.rest.git.createBlob({
      owner: REPO_OWNER,
      repo: repo.name,
      content: content.toString("base64"),
      encoding: "base64",
    });
    return data.sha;
  }

  /**
   * Read a blob by sha. Preferred over path lookups for chunk reads: the
   * manifest already carries each chunk's blob sha, so streaming a file needs
   * no tree walks at all.
   */
  async getBlob(sha: string): Promise<Buffer> {
    const repo = await this.getOrCreateRepo();
    const { data } = await this.octokit.rest.git.getBlob({
      owner: REPO_OWNER,
      repo: repo.name,
      file_sha: sha,
    });
    return Buffer.from(data.content, "base64");
  }

  /**
   * Every blob in a tree, keyed by path.
   *
   * Uses the recursive tree endpoint rather than the Contents API, which caps
   * its listing at roughly a thousand entries and returns nothing for the rest.
   * Callers that need several paths fetch this once and index into it.
   */
  async getTreeEntries(treeSha: string): Promise<Map<string, TreeEntry>> {
    const repo = await this.getOrCreateRepo();
    const { data } = await this.octokit.rest.git.getTree({
      owner: REPO_OWNER,
      repo: repo.name,
      tree_sha: treeSha,
      recursive: "1",
    });

    const map = new Map<string, TreeEntry>();
    for (const entry of data.tree) {
      if (entry.type !== "blob" || !entry.path || !entry.sha) continue;
      map.set(entry.path, { path: entry.path, sha: entry.sha, size: entry.size ?? 0 });
    }
    return map;
  }

  /** Head tree sha of the target branch, or null if the branch has no commits. */
  async getBranchTreeSha(repo: RepoInfo): Promise<string | null> {
    const head = await this.getBranchHead(repo);
    return head ? head.treeSha : null;
  }

  /** Read one file by path, given a tree sha the caller already holds. */
  async getFileContent(treeSha: string, path: string): Promise<Buffer> {
    const entries = await this.getTreeEntries(treeSha);
    const entry = entries.get(path);
    if (!entry) throw new Error(`file not found: ${path}`);
    return this.getBlob(entry.sha);
  }

  private async getBranchHead(
    repo: RepoInfo
  ): Promise<{ commitSha: string; treeSha: string } | null> {
    try {
      const { data: ref } = await this.octokit.rest.git.getRef({
        owner: REPO_OWNER,
        repo: repo.name,
        ref: `heads/${this.branch}`,
      });
      const { data: commit } = await this.octokit.rest.git.getCommit({
        owner: REPO_OWNER,
        repo: repo.name,
        commit_sha: ref.object.sha,
      });
      return { commitSha: ref.object.sha, treeSha: commit.tree.sha };
    } catch {
      // Branch (or repo) does not exist yet.
      return null;
    }
  }

  /**
   * Commit a set of already-uploaded blobs in one atomic operation.
   *
   * One tree + one commit + one ref update means a partial upload can never
   * leave stray files behind. The ref update is a compare-and-swap: if a
   * concurrent writer moved the branch, GitHub rejects it (force:false) and we
   * re-read the head and replay, rather than silently clobbering their commit.
   */
  async commitFiles(files: FileToCommit[], message: string): Promise<string> {
    if (files.length === 0) throw new Error("nothing to commit");
    const repo = await this.getOrCreateRepo();

    for (let attempt = 1; attempt <= COMMIT_MAX_ATTEMPTS; attempt++) {
      const head = await this.getBranchHead(repo);

      const { data: tree } = await this.octokit.rest.git.createTree({
        owner: REPO_OWNER,
        repo: repo.name,
        ...(head ? { base_tree: head.treeSha } : {}),
        tree: files.map((f) => ({
          path: f.path,
          mode: "100644" as const,
          type: "blob" as const,
          sha: f.sha,
        })),
      });

      const { data: commit } = await this.octokit.rest.git.createCommit({
        owner: REPO_OWNER,
        repo: repo.name,
        message,
        tree: tree.sha,
        ...(head ? { parents: [head.commitSha] } : {}),
        author: { name: this.commitName, email: this.commitEmail },
        committer: { name: this.commitName, email: this.commitEmail },
      });

      if (!head) {
        // First commit on this branch — create the ref at it. A racing creator
        // makes this fail, which the catch below retries as an update.
        try {
          await this.octokit.rest.git.createRef({
            owner: REPO_OWNER,
            repo: repo.name,
            ref: `refs/heads/${this.branch}`,
            sha: commit.sha,
          });
          return commit.sha;
        } catch (err) {
          if (attempt === COMMIT_MAX_ATTEMPTS) throw err;
          continue;
        }
      }

      try {
        await this.octokit.rest.git.updateRef({
          owner: REPO_OWNER,
          repo: repo.name,
          ref: `heads/${this.branch}`,
          sha: commit.sha,
          force: false,
        });
        return commit.sha;
      } catch (err) {
        const status = (err as { status?: number }).status;
        // 422/409 = the ref moved under us; re-read the head and replay.
        const retryable = status === 422 || status === 409;
        if (retryable && attempt < COMMIT_MAX_ATTEMPTS) continue;
        throw err;
      }
    }

    throw new Error("commit failed after retries: branch ref kept moving");
  }

  async deleteRepo(repo: RepoInfo): Promise<void> {
    await this.octokit.rest.repos.delete({
      owner: REPO_OWNER,
      repo: repo.name,
    });
  }
}
