import { Router } from "express";
import { GitHubService } from "../services/github.js";
import { showData, showError } from "../utils/response.js";
import { adminAuth } from "../middleware/adminAuth.js";

export const clearRouter = Router();

clearRouter.use(adminAuth);

clearRouter.get("/", async (_req, res) => {
  const github = new GitHubService();
  try {
    const repo = await github.getOrCreateRepo();
    await github.deleteRepo(repo);
    showData(res, { message: "Repository cleared successfully" });
  } catch (err) {
    showError(res, "Failed to clear repository");
  }
});