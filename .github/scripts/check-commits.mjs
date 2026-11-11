// Checks the commits a pull request brings: no coding-assistant signature in
// any commit message and, when the branch lives in this repository, every
// commit made by the repository owner. Run by the `commits` job in ci.yml.
import { pathToFileURL } from "node:url";

const SIGNATURES = [
  [/^co-authored-by:.*(claude|anthropic|codex|openai|copilot|cursor)/i, "'Co-authored-by:' line that names a coding assistant"],
  [/^claude-session:/i, "'Claude-Session:' line"],
  [/generated with\s+\[?(claude|codex|cursor|copilot)\b/i, "'Generated with ...' line"],
];
const OTHER = "another account";
const UNKNOWN = "an account GitHub does not recognise";
const REWORD = "git commit --amend, or git rebase -i for an older commit";
const REAUTHOR = "re-commit it under the owner's git identity (git commit --amend --reset-author)";

// `commits` is the array GET /repos/{owner}/{repo}/pulls/{n}/commits returns.
// Problems never print another account's login or the e-mail in the commit.
export function findProblems(commits, { owner, sameRepo }) {
  const problems = [];
  for (const { sha, commit, author, committer } of commits) {
    const short = sha.slice(0, 7);
    const lines = commit.message.split("\n").map((line) => line.trim());
    for (const [pattern, what] of SIGNATURES) {
      if (lines.some((line) => pattern.test(line))) {
        problems.push(`${short} remove the ${what} from the commit message (${REWORD})`);
      }
    }
    if (!sameRepo) continue;
    const bot = author?.login === "dependabot[bot]";
    if (!bot && author?.login !== owner) {
      problems.push(`${short} is authored by ${author ? OTHER : UNKNOWN}, not the repository owner ${owner}; ${REAUTHOR}`);
    }
    const committers = bot ? [owner, "web-flow", "dependabot[bot]"] : [owner, "web-flow"];
    if (!committers.includes(committer?.login)) {
      problems.push(`${short} is committed by ${committer ? OTHER : UNKNOWN}, not the repository owner ${owner} or web-flow; ${REAUTHOR}`);
    }
  }
  return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const required = ["GITHUB_REPOSITORY", "PR_NUMBER", "HEAD_REPO", "GITHUB_REPOSITORY_OWNER", "GITHUB_TOKEN"];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) {
    console.error(`Missing environment variables: ${missing.join(", ")}`);
    process.exit(1);
  }
  const { GITHUB_REPOSITORY, PR_NUMBER, HEAD_REPO, GITHUB_REPOSITORY_OWNER, GITHUB_TOKEN } = process.env;
  const api = process.env.GITHUB_API_URL || "https://api.github.com";

  const commits = [];
  for (let page = 1; ; page++) {
    const response = await fetch(
      `${api}/repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}/commits?per_page=100&page=${page}`,
      {
        headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(30000),
      },
    );
    if (response.status !== 200) {
      console.error(`Listing the pull request's commits failed: HTTP ${response.status}`);
      process.exit(1);
    }
    const items = await response.json();
    commits.push(...items);
    if (items.length < 100) break;
  }

  const problems = findProblems(commits, {
    owner: GITHUB_REPOSITORY_OWNER,
    sameRepo: HEAD_REPO === GITHUB_REPOSITORY,
  });
  if (problems.length) {
    for (const problem of problems) console.error(problem);
    process.exitCode = 1;
  } else {
    console.log(`${commits.length} commits checked`);
  }
}
