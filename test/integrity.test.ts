import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { assertContainedLinks, captureTree, inspectCandidate, IntegrityError, LinkBoundaryError } from "../src/integrity.ts";

async function withTree(verify: (root: string, directory: string) => Promise<void>) {
  const tempRoot = resolve(tmpdir());
  const directory = await mkdtemp(join(tempRoot, "repopilot-integrity-test-"));
  const root = join(directory, "worktree");
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "test"));
    await writeFile(join(root, "src/paginate.ts"), "export const pages = 1;\n");
    await writeFile(join(root, "test/paginate.test.ts"), "test fixture\n");
    await writeFile(join(root, "package.json"), "{}\n");
    await verify(root, directory);
  } finally {
    assert.equal(dirname(resolve(directory)), tempRoot);
    await rm(directory, { recursive: true, force: true });
  }
}

test("tree fingerprints ignore modification time and never contain file contents", async () => {
  await withTree(async root => {
    const marker = "PUBLIC_FIXTURE_CONTENT_SHOULD_ONLY_BE_HASHED";
    await writeFile(join(root, "src/marker.ts"), marker);
    const before = await captureTree(root);
    await utimes(join(root, "src/marker.ts"), new Date(1_000), new Date(2_000));
    const after = await captureTree(root);
    assert.equal(before.fingerprint, after.fingerprint);
    assert.deepEqual(before.files, after.files);
    assert.equal(before.files["src/marker.ts"]?.hash.length, 64);
    assert.ok(!JSON.stringify(before).includes(marker));
    assert.equal(inspectCandidate(before, after, ["src/paginate.ts"]).valid, false);
  });
});

test("only content changes to existing allowed regular files are accepted", async () => {
  await withTree(async root => {
    const before = await captureTree(root);
    await writeFile(join(root, "src/paginate.ts"), "export const pages = 0;\n");
    const after = await captureTree(root);
    assert.notEqual(before.fingerprint, after.fingerprint);
    assert.deepEqual(inspectCandidate(before, after, ["src/paginate.ts"]).changedPaths, ["src/paginate.ts"]);
    assert.equal(inspectCandidate(before, after, ["src/paginate.ts"]).valid, true);
  });
});

test("changes to tests and configuration are rejected even alongside a source fix", async () => {
  for (const protectedPath of ["test/paginate.test.ts", "package.json"]) {
    await withTree(async root => {
      const before = await captureTree(root);
      await writeFile(join(root, "src/paginate.ts"), "export const pages = 0;\n");
      await writeFile(join(root, protectedPath), "changed fixture\n");
      const result = inspectCandidate(before, await captureTree(root), ["src/paginate.ts"]);
      assert.equal(result.valid, false);
      assert.ok(result.changedPaths.includes(protectedPath));
    });
  }
});

test("ignored and untracked files are included rather than hidden by Git ignore rules", async () => {
  await withTree(async root => {
    await writeFile(join(root, ".gitignore"), "cache/\n");
    await mkdir(join(root, "cache"));
    const before = await captureTree(root);
    await writeFile(join(root, "cache/untracked.txt"), "new fixture\n");
    const result = inspectCandidate(before, await captureTree(root), ["src/paginate.ts"]);
    assert.equal(result.valid, false);
    assert.deepEqual(result.changedPaths, ["cache/untracked.txt"]);
  });
});

test("source deletion and file-to-directory replacement are rejected", async () => {
  await withTree(async root => {
    const before = await captureTree(root);
    await rm(join(root, "src/paginate.ts"));
    assert.equal(inspectCandidate(before, await captureTree(root), ["src/paginate.ts"]).valid, false);
    await mkdir(join(root, "src/paginate.ts"));
    assert.equal(inspectCandidate(before, await captureTree(root), ["src/paginate.ts"]).valid, false);
  });
});

test("dependency content is protected even though node_modules is ignored", async () => {
  await withTree(async root => {
    await writeFile(join(root, ".gitignore"), "node_modules/\n");
    await mkdir(join(root, "node_modules/dependency"), { recursive: true });
    await writeFile(join(root, "node_modules/dependency/index.js"), "export const value = 1;\n");
    const before = await captureTree(root);
    await writeFile(join(root, "node_modules/dependency/index.js"), "export const value = 0;\n");
    const result = inspectCandidate(before, await captureTree(root), ["src/paginate.ts"]);
    assert.equal(result.valid, false);
    assert.deepEqual(result.changedPaths, ["node_modules/dependency/index.js"]);
  });
});

test("symbolic links and Windows junctions are hashed without traversing their targets", async () => {
  await withTree(async (root, directory) => {
    const outside = join(directory, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "external.txt"), "initial external fixture\n");
    await symlink(outside, join(root, "external-link"), process.platform === "win32" ? "junction" : "dir");
    const before = await captureTree(root);
    assert.equal(before.files["external-link"]?.kind, "symlink");
    assert.ok(!Object.hasOwn(before.files, "external-link/external.txt"));
    await writeFile(join(outside, "external.txt"), "changed external fixture\n");
    assert.equal((await captureTree(root)).fingerprint, before.fingerprint);
    const secondOutside = join(directory, "another-outside");
    await mkdir(secondOutside);
    await rm(join(root, "external-link"));
    await symlink(secondOutside, join(root, "external-link"), process.platform === "win32" ? "junction" : "dir");
    const result = inspectCandidate(before, await captureTree(root), ["external-link"]);
    assert.equal(result.valid, false);
    assert.deepEqual(result.changedPaths, ["external-link"]);
  });
});

test("a root .git directory is metadata-only but a worktree .git pointer is protected", async () => {
  await withTree(async root => {
    await mkdir(join(root, ".git/objects"), { recursive: true });
    await writeFile(join(root, ".git/objects/fixture"), "internal Git fixture\n");
    const metadataOnly = await captureTree(root);
    assert.equal(metadataOnly.files[".git"]?.kind, "directory");
    assert.ok(!Object.hasOwn(metadataOnly.files, ".git/objects"));
    const gitDirectory = resolve(root, ".git");
    assert.equal(dirname(gitDirectory), resolve(root));
    await rm(gitDirectory, { recursive: true });
    await writeFile(join(root, ".git"), "gitdir: fixture-one\n");
    const before = await captureTree(root);
    await writeFile(join(root, ".git"), "gitdir: fixture-two\n");
    const result = inspectCandidate(before, await captureTree(root), ["src/paginate.ts"]);
    assert.equal(result.valid, false);
    assert.deepEqual(result.changedPaths, [".git"]);
  });
});

test("permission changes are rejected even on allowed source files", async () => {
  await withTree(async root => {
    const path = join(root, "src/paginate.ts");
    const before = await captureTree(root);
    try {
      await chmod(path, 0o444);
      const after = await captureTree(root);
      assert.notEqual(before.files["src/paginate.ts"]?.mode, after.files["src/paginate.ts"]?.mode);
      assert.equal(inspectCandidate(before, after, ["src/paginate.ts"]).valid, false);
    } finally {
      await chmod(path, 0o666);
    }
  });
});

test("capture failures use a fixed safe error", async () => {
  await withTree(async root => {
    const missingPath = join(root, "PRIVATE_PATH_FIXTURE_DO_NOT_ECHO");
    await assert.rejects(captureTree(missingPath), error => {
      assert.ok(error instanceof IntegrityError);
      assert.equal(error.code, "TREE_CAPTURE_FAILED");
      assert.ok(!error.message.includes("PRIVATE_PATH_FIXTURE_DO_NOT_ECHO"));
      return true;
    });
    assert.equal(await readFile(join(root, "src/paginate.ts"), "utf8"), "export const pages = 1;\n");
  });
});

test("external links are rejected including ignored dependencies without exposing their targets", async () => {
  for (const linkPath of ["external-link", "node_modules/dependency"]) {
    await withTree(async (root, directory) => {
      const outside = join(directory, "PRIVATE_EXTERNAL_TARGET_DO_NOT_ECHO");
      await mkdir(outside);
      await writeFile(join(outside, "index.js"), "external dependency fixture\n");
      await mkdir(join(root, "node_modules"));
      await writeFile(join(root, ".gitignore"), "node_modules/\n");
      await symlink(outside, join(root, linkPath), process.platform === "win32" ? "junction" : "dir");
      await assert.rejects(assertContainedLinks(root), error => {
        assert.ok(error instanceof LinkBoundaryError);
        assert.equal(error.code, "LINK_BOUNDARY_INVALID");
        assert.ok(!error.message.includes("PRIVATE_EXTERNAL_TARGET_DO_NOT_ECHO"));
        return true;
      });
    });
  }
});

test("contained dependency links are accepted and their real contents stay in the original snapshot", async () => {
  await withTree(async root => {
    await mkdir(join(root, "node_modules"));
    await symlink(join(root, "src"), join(root, "node_modules/internal"), process.platform === "win32" ? "junction" : "dir");
    await assertContainedLinks(root);
    const before = await captureTree(root);
    assert.ok(!Object.hasOwn(before.files, "node_modules/internal/paginate.ts"));
    await writeFile(join(root, "src/paginate.ts"), "export const pages = 0;\n");
    await assertContainedLinks(root);
    const after = await captureTree(root);
    assert.notEqual(before.fingerprint, after.fingerprint);
    assert.equal(before.files["node_modules/internal"]?.hash, after.files["node_modules/internal"]?.hash);
  });
});

test("broken links and unresolvable self links are rejected", async () => {
  for (const targetName of ["missing-directory", "invalid-link"]) {
    await withTree(async root => {
      await symlink(resolve(root, targetName), join(root, "invalid-link"), process.platform === "win32" ? "junction" : "dir");
      await assert.rejects(assertContainedLinks(root), LinkBoundaryError);
    });
  }
});

test("an internal directory link to an ancestor is accepted without recursive traversal", async () => {
  await withTree(async root => {
    await symlink(root, join(root, "ancestor-link"), process.platform === "win32" ? "junction" : "dir");
    await assertContainedLinks(root);
    const snapshot = await captureTree(root);
    assert.equal(snapshot.files["ancestor-link"]?.kind, "symlink");
    assert.ok(!Object.hasOwn(snapshot.files, "ancestor-link/src"));
  });
});

test("link inspection excludes a root .git directory", async () => {
  await withTree(async (root, directory) => {
    await mkdir(join(root, ".git"));
    const outside = join(directory, "external-git-fixture");
    await mkdir(outside);
    await symlink(outside, join(root, ".git/ignored-link"), process.platform === "win32" ? "junction" : "dir");
    await assertContainedLinks(root);
  });
});
