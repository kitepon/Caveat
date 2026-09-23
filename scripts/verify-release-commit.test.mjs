import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import cliPackage from "../apps/cli/package.json" with { type: "json" };
import { verifyReleaseCommit } from "./verify-release-commit.mjs";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

async function landedWorktree(t) {
  const root = await mkdtemp(path.join(tmpdir(), "caveat-release-gate-"));
  const remote = path.join(root, "origin.git");
  const work = path.join(root, "work");
  t.after(async () => rm(root, { recursive: true, force: true }));

  await mkdir(work);
  git(root, "init", "--bare", remote);
  git(work, "init", "--initial-branch=main");
  git(work, "config", "user.name", "Caveat release gate test");
  git(work, "config", "user.email", "caveat-release-gate@example.invalid");
  await writeFile(path.join(work, ".gitignore"), "ignored.tmp\n", "utf8");
  await writeFile(path.join(work, "tracked.txt"), "tracked\n", "utf8");
  git(work, "add", ".gitignore", "tracked.txt");
  git(work, "commit", "-m", "fixture");
  git(work, "remote", "add", "origin", remote);
  git(work, "push", "--set-upstream", "origin", "main");
  return work;
}

test("mainへ着地済みのcommitは通過する", async (t) => {
  const work = await landedWorktree(t);
  assert.match(verifyReleaseCommit({ projectDirectory: work }), /landed on origin\/main/);
});

test("untracked payloadは拒否する", async (t) => {
  const work = await landedWorktree(t);
  await writeFile(path.join(work, "untracked.txt"), "must block publish\n", "utf8");
  assert.throws(
    () => verifyReleaseCommit({ projectDirectory: work }),
    /working treeに未commitの変更があります/
  );
});

test("ignore済み生成物は通過する", async (t) => {
  const work = await landedWorktree(t);
  await writeFile(path.join(work, "ignored.tmp"), "generated\n", "utf8");
  assert.match(verifyReleaseCommit({ projectDirectory: work }), /landed on origin\/main/);
});

test("CLI publishは--no-git-checksでもroot gateをprepublishOnlyで実行する", () => {
  assert.equal(cliPackage.scripts.prepublishOnly, "node ../../scripts/verify-release-commit.mjs");
});

test("公開CLI versionは現行文書とCHANGELOGに同期する", async () => {
  const version = cliPackage.version;
  for (const [name, url] of [
    ["README.md", new URL("../README.md", import.meta.url)],
    ["README.ja.md", new URL("../README.ja.md", import.meta.url)],
    ["AGENTS.md", new URL("../AGENTS.md", import.meta.url)],
  ]) {
    const source = await readFile(url, "utf8");
    assert.ok(source.includes(`v${version}`), `${name} must state v${version}`);
  }
  const changelog = await readFile(new URL("../CHANGELOG.md", import.meta.url), "utf8");
  assert.ok(changelog.includes(`## [${version}] — `), `CHANGELOG.md must contain ${version}`);
});
