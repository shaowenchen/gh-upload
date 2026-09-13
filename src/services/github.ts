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

/**
 * Blob reads kept in memory, keyed by sha.
 *
 * A git blob sha is the hash of its content, so this entry cannot go stale: if
 * the content changed, the sha would be different and this would be a different
 * entry. That is why there is no TTL here — correctness comes from
 * content-addressing, not from an expiry guess.
 *
 * Only blobs below the size cutoff are kept. A manifest is a few kilobytes; a
 * chunk is megabytes, and caching those would put a file's whole contents in
 * the heap to save one round trip.
 *
 * Bounded in bytes rather than entries, because the entries vary in size by
 * orders of magnitude and what actually has to stay bounded is the heap.
 */
const BLOB_CACHE_MAX_BYTES = 8 * 1024 * 1024;
const BLOB_CACHE_MAX_ENTRY_BYTES = 256 * 1024;

/**
 * The cache itself, at module scope rather than per instance.
 *
 * It has to outlive a request to be worth anything — listing fetches the same
 * manifests on every call — and it is safe to share across instances because it
 * is global to the deployment rather than scoped to one. It is shared across
 * callers deliberately: the data is a pure function of the sha, so there is
 * nothing to leak between them.
 */
const blobCache = new Map<string, Buffer>();
let blobCacheBytes = 0;

/** Cached blob bytes, for tests and diagnostics. */
export function blobCacheStats(): { entries: number; bytes: number } {
  return { entries: blobCache.size, bytes: blobCacheBytes };
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
  /**
   * Bootstraps currently running, so concurrent callers await one attempt
   * instead of racing each other into a duplicate branch creation.
   */
  private bootstrapPromises = new Map<string, Promise<void>>();

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
      private: config.github.repoPrivate,
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
    const cached = blobCache.get(sha);
    if (cached !== undefined) {
      // Refresh recency: deleting and re-setting moves the entry to the end of
      // the Map's insertion order, which is what makes the eviction below
      // least-recently-used rather than first-in-first-out. Without this a file
      // listed on every page load could be evicted ahead of one read once. The
      // byte counter is untouched because the buffer is the same one.
      blobCache.delete(sha);
      blobCache.set(sha, cached);
      return cached;
    }

    const repo = await this.getOrCreateRepo();
    const { data } = await this.withRetry("getBlob", () =>
      this.octokit.rest.git.getBlob({
        owner: REPO_OWNER,
        repo: repo.name,
        file_sha: sha,
      })
    );
    const content = Buffer.from(data.content, "base64");

    // Only worth holding if it is small. The budget is enforced by evicting the
    // least recently used entry, which is at the front of the Map's order.
    if (content.length <= BLOB_CACHE_MAX_ENTRY_BYTES) {
      blobCache.delete(sha);
      blobCache.set(sha, content);
      blobCacheBytes += content.length;
      while (blobCacheBytes > BLOB_CACHE_MAX_BYTES && blobCache.size > 1) {
        const oldest = blobCache.keys().next();
        if (oldest.done || oldest.value === sha) break;
        const evicted = blobCache.get(oldest.value);
        blobCache.delete(oldest.value);
        blobCacheBytes -= evicted?.length ?? 0;
      }
    }
    return content;
  }

  /**
   * Every blob in a tree, keyed by path.
   *
   * Uses the recursive tree endpoint rather than the Contents API, which caps
   * its listing at roughly a thousand entries and returns nothing for the rest.
   * Callers that need several paths fetch this once and index into it.
   *
   * Throws when the response is truncated rather than returning the partial
   * listing. GitHub stops walking at its item limit and flags the response
   * instead of failing, so an unchecked caller would treat "more objects than
   * fit" as "these are all the objects" — and for the file list that is a
   * silently incomplete page rather than an error.
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

    if (data.truncated) {
      throw new Error(
        `tree ${treeSha} is too large for a single recursive listing; the result would be incomplete`
      );
    }

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

  /**
   * Read one file by path.
   *
   * Resolves the path directly with the Contents API rather than walking the
   * tree and indexing into it. A tree walk is only correct while the response
   * is untruncated, so a lookup that could not be satisfied from it reported a
   * file as missing when the file existed — and that lands on the download
   * path, where the id was issued by this server in the first place.
   *
   * The manifest is a few kilobytes, well inside the Contents API's 1MB
   * inline-content ceiling, so this stays a single request.
   */
  async getFileContent(path: string): Promise<Buffer> {
    const repo = await this.getOrCreateRepo();
    const { data } = await this.withRetry("getContent", () =>
      this.octokit.rest.repos.getContent({
        owner: REPO_OWNER,
        repo: repo.name,
        path,
        ref: this.branch,
      })
    );

    // The endpoint answers with an array for a directory and an object for a
    // file; only the latter carries inline content.
    if (Array.isArray(data) || data.type !== "file" || typeof data.content !== "string") {
      throw new Error(`not a file: ${path}`);
    }
    return Buffer.from(data.content, "base64");
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

    // Chunks upload concurrently, so several of them can reach this at once on
    // a repository that has not been bootstrapped yet. The check above is only
    // a fast path — the work below awaits several round trips, and every caller
    // that got past the check before the first one finished would do the whole
    // bootstrap again. The loser of that race gets GitHub's 409 "reference
    // already exists" from the branch it just created, and a 409 is not
    // retryable, so the chunk fails outright.
    //
    // One shared promise collapses them: the first caller does the work, the
    // rest await the same result, and a failure is not cached so the next
    // caller retries rather than inheriting it.
    let inFlight = this.bootstrapPromises.get(repo.name);
    if (!inFlight) {
      // Recorded only while this attempt is still the registered one. A clear
      // that lands mid-bootstrap drops the entry, and this check is what stops
      // the finishing attempt from marking a since-deleted repository as ready
      // — which would make the next write skip the bootstrap it now needs.
      const isCurrent = () => this.bootstrapPromises.get(repo.name) === chain;
      const chain: Promise<void> = this.bootstrap(repo)
        .then(() => {
          if (isCurrent()) this.bootstrapped.add(repo.name);
        })
        .finally(() => {
          if (isCurrent()) this.bootstrapPromises.delete(repo.name);
        });
      this.bootstrapPromises.set(repo.name, chain);
      inFlight = chain;
    }
    await inFlight;
  }

  /**
   * Bring the repository into a state where git-data writes will be accepted.
   *
   * Two separate preconditions, in order: the repository has to have a commit
   * at all, and the target branch has to exist.
   */
  private async bootstrap(repo: RepoInfo): Promise<void> {
    const head = await this.getBranchHead(repo);
    if (head) return;

    // The target branch may simply not exist yet on a repo that does have
    // commits — then it only needs to be branched off the default branch.
    const defaultHead = await this.getBranchHead({
      name: repo.name,
      defaultBranch: repo.defaultBranch,
    }, repo.defaultBranch);

    if (!defaultHead) {
      // The repository has no commits. The git-data API refuses to write
      // objects to it, so the first commit has to come from the Contents API,
      // which does create one.
      //
      // A concurrent creator can still win here — another pod, or a retry — and
      // GitHub answers that with 409. That is the state this method exists to
      // establish, so it is success, not failure.
      try {
        await this.octokit.rest.repos.createOrUpdateFileContents({
          owner: REPO_OWNER,
          repo: repo.name,
          path: "README.md",
          message: "Initialize upload repository",
          content: Buffer.from(BOOTSTRAP_README, "utf-8").toString("base64"),
          branch: repo.defaultBranch,
          author: { name: this.commitName, email: this.commitEmail },
          committer: { name: this.commitName, email: this.commitEmail },
        });
      } catch (err) {
        if ((err as { status?: number }).status !== 409) throw err;
        // Someone else created the branch first; fall through to the branch
        // creation below, which re-reads the head it produced.
      }
      if (repo.defaultBranch === this.branch) return;
    }

    await this.createBranchIfMissing(repo, repo.defaultBranch);
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
    try {
      await this.octokit.rest.git.createRef({
        owner: REPO_OWNER,
        repo: repo.name,
        ref: `refs/heads/${this.branch}`,
        sha: source.commitSha,
      });
    } catch (err) {
      // Another pod, or a retry, created it between the check above and here.
      // The branch is the state this method exists to establish, so a 422 from
      // a losing race is success. Anything else is real.
      if ((err as { status?: number }).status !== 422) throw err;
    }
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
    // The caches now describe a repository that does not exist. Leaving them
    // would make the next request use a stale repo for up to the cache TTL, and
    // `bootstrapped` would claim the repository already has a commit when the
    // next write has to recreate it from nothing.
    this.forgetRepo(repo.name);
  }

  /**
   * Drop everything cached about a repository.
   *
   * Called when the repository is deleted; a shared service instance would
   * otherwise serve the deleted repository's identity until the TTL expired.
   */
  private forgetRepo(name: string): void {
    this.repoPromise = null;
    this.repoCachedAt = 0;
    this.bootstrapped.delete(name);
    // Dropped rather than awaited: a bootstrap still running against the
    // deleted repository will find its `isCurrent()` check fail and decline to
    // record anything. Waiting here would block the clear on work that is about
    // to become irrelevant.
    this.bootstrapPromises.delete(name);
  }
}

/**
 * The service instance the routes share.
 *
 * Every route used to construct its own, which meant the repo, org and
 * bootstrap caches in here were rebuilt from scratch on every request and never
 * outlived the one that created them — so each request paid the org probe and
 * the repo lookup again. A single instance is what makes those caches actually
 * cache.
 *
 * It is safe to share: the only mutable state is those caches, and the config
 * it reads is fixed for the process's lifetime.
 */
let shared: GitHubService | null = null;

export function githubService(): GitHubService {
  if (!shared) shared = new GitHubService();
  return shared;
}
