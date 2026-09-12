import { Router } from "express";
import { githubService } from "../services/github.js";
import { showData, showError } from "../utils/response.js";

export const clearRouter = Router();

// A GET that deletes the repository can be triggered by any page the operator
// visits in a browser, so require a POST and confirm intent.
clearRouter.post("/", async (_req, res) => {
  const github = githubService();
  try {
    const repo = await github.getOrCreateRepo();
    await github.deleteRepo(repo);
    showData(res, { message: "Repository cleared successfully" });
  } catch (err) {
    showError(res, "Failed to clear repository");
  }
});