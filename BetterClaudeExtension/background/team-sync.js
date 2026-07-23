/**
 * Team/Shared Plugin Sync — extension port. electron/team-sync.js shells out
 * to the system `git` binary; a Manifest V3 service worker can't spawn
 * processes or touch a filesystem at all, so this fetches the same files a
 * `git clone --depth 1` would land on disk via GitHub's REST "get repository
 * content" API instead (recursive tree + raw file fetch). Repo URL must be a
 * github.com repo for this to work — that's a real capability narrowing
 * from the Electron version (any git remote there) worth calling out in the
 * README rather than silently swallowing non-GitHub URLs.
 *
 * classify() is copied verbatim in spirit from electron/team-sync.js (same
 * five statuses, same manifest-hash reasoning) but reads repo/local content
 * from function arguments instead of fs.readFileSync, and hashes with
 * WebCrypto SHA-256 instead of Node's crypto module.
 */

function parseGithubRepoUrl(url) {
  const m = /github\.com[/:]([^/]+)\/([^/.]+?)(\.git)?$/i.exec(String(url || "").trim());
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function githubHeaders(token) {
  const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

// Recursively walks a repo's git tree (one API call, `?recursive=1`) and
// returns blobs whose path ends in one of `exts`.
async function listMatchingFiles({ owner, repo, branch, token }) {
  const branchRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/branches/${encodeURIComponent(branch || "main")}`, { headers: githubHeaders(token) });
  if (!branchRes.ok) throw new Error(`Couldn't read branch "${branch || "main"}" (HTTP ${branchRes.status})`);
  const branchData = await branchRes.json();
  const treeSha = branchData.commit.commit.tree.sha;

  const treeRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/${treeSha}?recursive=1`, { headers: githubHeaders(token) });
  if (!treeRes.ok) throw new Error(`Couldn't read repo tree (HTTP ${treeRes.status})`);
  const treeData = await treeRes.json();
  const exts = [".claudeplugin.js", ".css"];
  return (treeData.tree || [])
    .filter((entry) => entry.type === "blob" && exts.some((ext) => entry.path.endsWith(ext)) && !entry.path.startsWith(".git/"))
    .map((entry) => ({ relPath: entry.path, filename: entry.path.split("/").pop(), sha: entry.sha }));
}

async function fetchFileContent({ owner, repo, sha }) {
  // The blob API returns base64 regardless of content type — simplest single
  // code path for both .js and .css files.
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/blobs/${sha}`, { headers: githubHeaders() });
  if (!res.ok) throw new Error(`Couldn't fetch file (HTTP ${res.status})`);
  const data = await res.json();
  const binary = atob(data.content.replace(/\n/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}

async function classify({ repoContent, localContent, manifestHash }) {
  const repoHash = await sha256(repoContent);
  if (localContent == null) return { status: "new", repoHash };
  const localHash = await sha256(localContent);
  if (localHash === repoHash) return { status: "in-sync", repoHash, localHash };
  if (manifestHash && localHash === manifestHash) return { status: "update-available", repoHash, localHash };
  if (manifestHash && repoHash === manifestHash) return { status: "local-edited", repoHash, localHash };
  return { status: "conflict", repoHash, localHash };
}

module.exports = { parseGithubRepoUrl, sha256, listMatchingFiles, fetchFileContent, classify };
