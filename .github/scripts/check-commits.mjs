// Checks the commits of a pull request whose branch lives in this repository:
// no coding-assistant signature in a commit message, and every commit made by
// the repository owner. A fork's pull request is not checked -- a contributor's
// commits are their own. Run by the `commits` job in ci.yml.
import { pathToFileURL } from "node:url";

const SIGNATURES = [
  // An assistant signs with its vendor's address or with its bare product
  // name; a person who happens to be called Claude does neither.
  [/^co-authored-by:.*<[^>]*@([\w.-]+\.)?(anthropic|openai|cursor)\.com>/i, "'Co-authored-by:' line that names a coding assistant"],
  [/^co-authored-by:\s*(claude( code)?|codex|(github )?copilot|cursor( agent)?)\s*</i, "'Co-authored-by:' line that names a coding assistant"],
  [/^claude-session:/i, "'Claude-Session:' line"],
  [/^[^a-z]*generated with\s+\[?(claude|codex|cursor|copilot)\b/i, "'Generated with ...' line"],
];
const OTHER = "another account";
const UNKNOWN = "an account GitHub does not recognise";
const REWORD = "git commit --amend, or git rebase -i for an older commit";
const REAUTHOR = "re-commit it under the owner's git identity (git commit --amend --reset-author)";

// `commits` is the array GET /repos/{owner}/{repo}/pulls/{n}/commits returns.
// Problems never print another account's login or the e-mail in the commit.
export function findProblems(commits, { owner, sameRepo }) {
  const problems = [];
  if (!sameRepo) return problems;
  for (const { sha, commit, author, committer } of commits) {
    const short = sha.slice(0, 7);
    const lines = commit.message.split("\n").map((line) => line.trim());
    for (const [pattern, what] of SIGNATURES) {
      const problem = `${short} remove the ${what} from the commit message (${REWORD})`;
      if (lines.some((line) => pattern.test(line)) && !problems.includes(problem)) {
        problems.push(problem);
      }
    }
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
  // The endpoint lists 250 commits at most; past that, some would go unread.
  if (commits.length >= 250) {
    console.error("This pull request has 250 commits or more, too many to check; split it.");
    process.exit(1);
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
