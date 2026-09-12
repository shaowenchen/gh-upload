import { Octokit } from "@octokit/rest";
import { config } from "../config.js";
import { Buffer } from "node:buffer";

const [REPO_OWNER, REPO_NAME] = config.github.repo.split("/");

/** How long to trust a cached repo lookup before hitting the API again. */
const REPO_CACHE_TTL_MS = 60_000;

/** Attempts to land a commit before giving up on ref contention. */
const COMMIT_MAX_ATTEMPTS = 5;

/** Attempts for a single GitHub API call before the failure reaches the client. */
const API_MAX_ATTEMPTS = 4;

/** Longest a retry will wait, so a bad header cannot stall an upload. */
const RETRY_MAX_DELAY_MS = 30_000;

/**
 * Whether a failed GitHub call is worth trying again.
 *
 * Asking this server rather than the client to retry is the point: a chunk that
 * fails upstream currently costs the client the whole chunk, its own backoff,
 * and a re-send — for a failure that was probably a few hundred milliseconds
 * long. Absorbing it here turns that into a pause the client never sees.
 */
function isRetryable(err: unknown): boolean {
  const e = err as { status?: number; message?: string };
  const status = e.status;

  if (status === 429) return true;
  // 500/502/503/504 are the transient upstream failures, and are the common
  // case: GitHub answers 502/503 under load and during internal deploys.
  if (status !== undefined && status >= 500) return true;
  // A 403 is either a genuine permission problem or an exhausted rate limit,
  // and only the second is worth waiting out. They are distinguishable from
  // the message, which GitHub words explicitly for the rate-limit case.
  if (status === 403) {
    const message = (e.message || "").toLowerCase();
    return message.includes("rate limit") || message.includes("secondary rate");
  }
  // No status at all means the request never got an answer: a dropped
  // connection, a socket timeout, a DNS blip. These are exactly the failures a
  // retry is meant to hide, and they are invisible to the client otherwise.
  if (status === undefined) return true;

  // Everything else — 401, 404, 422 — is a real answer that will not change.
  return false;
}

/**
 * Delay before the given retry, with jitter.
 *
 * The jitter matters more than the base: chunks are uploaded concurrently and
 * fail together when the upstream is struggling, so without it every retry
 * returns at the same instant and reproduces the overload it was backing off
 * from.
 */
function retryDelayMs(attempt: number, retryAfterHeader?: string): number {
  // An explicit Retry-After is authoritative — GitHub sets it on secondary rate
  // limits, and coming back sooner just earns another rejection.
  const retryAfter = Number(retryAfterHeader);
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, RETRY_MAX_DELAY_MS);
  }
  const base = Math.min(300 * 2 ** (attempt - 1), 8_000);
  return Math.floor(base / 2 + Math.random() * (base / 2));
}

/**
 * Committed as the repository's first commit, to bring it into existence.
 * The git-data API cannot write to a repository with no commits, so something
 * has to be committed first — this says what the repository holds.
 */
const BOOTSTRAP_README = `# upload repository

Managed by [gh-upload](https://github.com/shaowenchen/gh-upload).

This repository stores files uploaded through the gh-upload service and is
written to automatically. Do not edit it by hand: files are committed with
generated names, and each stored file is identified by a manifest describing
its chunks.

This README exists because git requires a repository to have a commit before
its object store can be written to.
`;

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
  /** Repos already known to have a commit, so the probe runs once each. */
  private bootstrapped = new Set<string>();

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
   * Run a GitHub call, retrying the failures that are worth retrying.
   *
   * Only raises the error once the attempts are exhausted, so a caller that
   * reports a 502 to the client is reporting something genuinely persistent
   * rather than a single unlucky request.
   */
  private async withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= API_MAX_ATTEMPTS; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (!isRetryable(err) || attempt === API_MAX_ATTEMPTS) throw err;
        const delay = retryDelayMs(
          attempt,
          (err as { response?: { headers?: Record<string, string> } }).response?.headers?.[
            "retry-after"
          ]
        );
        console.warn(
          `github ${label} failed (attempt ${attempt}/${API_MAX_ATTEMPTS}), retrying in ${delay}ms`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw lastErr;
  }

  /**
   * Write a blob and return its sha.
   *
   * Blobs are content-addressed and attach to no ref, so chunks can be uploaded
   * concurrently without contending for the branch ref — and re-sending a chunk
   * of identical content resolves to the same object instead of a second write.
   * Only commitFiles touches the ref.
   *
   * This is the hot path for a large upload, so it carries the retry: an upload
   * makes one of these per chunk, and a transient failure here is the single
   * most likely way for a chunk to fail.
   */
  async createBlob(content: Buffer): Promise<string> {
    const repo = await this.getOrCreateRepo();
    await this.ensureWritable(repo);
    const { data } = await this.withRetry("createBlob", () =>
      this.octokit.rest.git.createBlob({
        owner: REPO_OWNER,
        repo: repo.name,
        content: content.toString("base64"),
        encoding: "base64",
      })
    );
    return data.sha;
  }

  /**
   * Read a blob by sha. Preferred over path lookups for chunk reads: the
   * manifest already carries each chunk's blob sha, so streaming a file needs
   * no tree walks at all.
   *
   * Retried because a download walks every chunk in turn: without it, one
   * transient failure part-way through truncates the response, and the client
   * has no way to resume.
   */
  async getBlob(sha: string): Promise<Buffer> {
    const repo = await this.getOrCreateRepo();
    const { data } = await this.withRetry("getBlob", () =>
      this.octokit.rest.git.getBlob({
        owner: REPO_OWNER,
        repo: repo.name,
        file_sha: sha,
      })
    );
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
    const { data } = await this.withRetry("getTree", () =>
      this.octokit.rest.git.getTree({
        owner: REPO_OWNER,
        repo: repo.name,
        tree_sha: treeSha,
        recursive: "1",
      })
    );

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

  /**
   * Make sure the target branch exists and the repository has a commit.
   *
   * The git-data API refuses to write to a repository with no commits — creating
   * a blob answers 409 "Git Repository is empty", because there is no commit for
   * the objects to belong to. A brand-new repository is exactly that, so the
   * first commit has to come from the Contents API, which does create one.
   *
   * The initial commit carries a README describing what the repository is for.
   * Something has to be committed to bootstrap it, and a note explaining the
   * contents is more honest than an empty placeholder.
   */
  private async ensureWritable(repo: RepoInfo): Promise<void> {
    if (this.bootstrapped.has(repo.name)) return;

    const head = await this.getBranchHead(repo);
    if (head) {
      this.bootstrapped.add(repo.name);
      return;
    }

    // The target branch may simply not exist yet on a repo that does have
    // commits — then it only needs to be branched off the default branch.
    const defaultHead = await this.getBranchHead({
      name: repo.name,
      defaultBranch: repo.defaultBranch,
    }, repo.defaultBranch);

    if (!defaultHead) {
      const filePath = "README.md";
      await this.octokit.rest.repos.createOrUpdateFileContents({
        owner: REPO_OWNER,
        repo: repo.name,
        path: filePath,
        message: "Initialize upload repository",
        content: Buffer.from(BOOTSTRAP_README, "utf-8").toString("base64"),
        branch: repo.defaultBranch,
        author: { name: this.commitName, email: this.commitEmail },
        committer: { name: this.commitName, email: this.commitEmail },
      });
      this.bootstrapped.add(repo.name);
      if (repo.defaultBranch === this.branch) return;
    }

    await this.createBranchIfMissing(repo, repo.defaultBranch);
    this.bootstrapped.add(repo.name);
  }

  /** Point the target branch at the given source branch's head, if absent. */
  private async createBranchIfMissing(
    repo: RepoInfo,
    sourceBranch: string
  ): Promise<void> {
    try {
      await this.octokit.rest.git.getRef({
        owner: REPO_OWNER,
        repo: repo.name,
        ref: `heads/${this.branch}`,
      });
      return; // already there
    } catch {
      // fall through to create it
    }
    const source = await this.getBranchHead(
      { name: repo.name, defaultBranch: sourceBranch },
      sourceBranch
    );
    if (!source) throw new Error(`source branch has no commits: ${sourceBranch}`);
    await this.octokit.rest.git.createRef({
      owner: REPO_OWNER,
      repo: repo.name,
      ref: `refs/heads/${this.branch}`,
      sha: source.commitSha,
    });
  }

  private async getBranchHead(
    repo: RepoInfo,
    branch?: string
  ): Promise<{ commitSha: string; treeSha: string } | null> {
    const target = branch ?? this.branch;
    try {
      const { data: ref } = await this.octokit.rest.git.getRef({
        owner: REPO_OWNER,
        repo: repo.name,
        ref: `heads/${target}`,
      });
      const { data: commit } = await this.octokit.rest.git.getCommit({
        owner: REPO_OWNER,
        repo: repo.name,
        commit_sha: ref.object.sha,
      });
      return { commitSha: ref.object.sha, treeSha: commit.tree.sha };
    } catch {
      // Branch (or repo) does not exist, or the repo has no commits at all.
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
    await this.ensureWritable(repo);

    for (let attempt = 1; attempt <= COMMIT_MAX_ATTEMPTS; attempt++) {
      const head = await this.getBranchHead(repo);

      const { data: tree } = await this.withRetry("createTree", () =>
        this.octokit.rest.git.createTree({
          owner: REPO_OWNER,
          repo: repo.name,
          ...(head ? { base_tree: head.treeSha } : {}),
          tree: files.map((f) => ({
            path: f.path,
            mode: "100644" as const,
            type: "blob" as const,
            sha: f.sha,
          })),
        })
      );

      const { data: commit } = await this.withRetry("createCommit", () =>
        this.octokit.rest.git.createCommit({
          owner: REPO_OWNER,
          repo: repo.name,
          message,
          tree: tree.sha,
          ...(head ? { parents: [head.commitSha] } : {}),
          author: { name: this.commitName, email: this.commitEmail },
          committer: { name: this.commitName, email: this.commitEmail },
        })
      );

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
