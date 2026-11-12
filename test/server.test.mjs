// Regression tests that drive the built server (dist/index.js) over MCP stdio
// against a disposable fixture. Run `npm run build` first; `npm test` does both.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
const isWin = process.platform === "win32";

let fx, root, stub;

before(() => {
  fx = mkdtempSync(join(tmpdir(), "just-bash-mcp-test-"));
  root = join(fx, "project");
  mkdirSync(root);
  mkdirSync(join(fx, "project-other"));
  mkdirSync(join(fx, "proj with space"));
  mkdirSync(join(fx, "stub"));
  writeFileSync(join(root, "a.txt"), "inside\n");
  writeFileSync(join(fx, "outside.txt"), "outside\n");
  writeFileSync(join(fx, "project-other", "b.txt"), "sibling\n");
  // Stub faf binary: echoes its argv and cwd as JSON so quoting is observable.
  writeFileSync(join(fx, "stub", "argv.cjs"), "console.log(JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd()}))\n");
  if (isWin) {
    stub = join(fx, "stub", "fakefaf.cmd");
    writeFileSync(stub, '@node "%~dp0argv.cjs" %*\r\n');
  } else {
    stub = join(fx, "stub", "fakefaf");
    writeFileSync(stub, `#!/bin/sh\nexec node "${join(fx, "stub", "argv.cjs")}" "$@"\n`);
    chmodSync(stub, 0o755);
  }
  if (isWin) mkdirSync(join(fx, "proj&echo INJECTED"));
});

after(() => rmSync(fx, { recursive: true, force: true }));

async function withServer(extraEnv, fn) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, JUST_BASH_PROJECT_ROOT: root, FAF_BIN: stub, FAF_MOLTBOT_BIN: stub, ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  let buf = "";
  const waiters = new Map();
  let id = 0;
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      waiters.get(m.id)?.(m);
    }
  });
  const rpc = (method, params) =>
    new Promise((r) => {
      const n = ++id;
      waiters.set(n, r);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
    });
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const call = async (name, args) => {
    const m = await rpc("tools/call", { name, arguments: args });
    return { isError: !!m.result?.isError, text: m.result?.content?.[0]?.text ?? "" };
  };
  const list = async () => (await rpc("tools/list", {})).result.tools.map((t) => t.name);
  try {
    await fn({ call, list, stderr: () => stderr });
  } finally {
    child.kill();
  }
}

const argvOf = (text) => JSON.parse(text.match(/\{"argv".*\}/)[0]);

test("realpath translates in-root paths and rejects every escape form", () =>
  withServer({}, async ({ call }) => {
    assert.equal((await call("realpath", { sandboxPath: "/home/user/project/a.txt" })).text, join(root, "a.txt"));
    assert.equal((await call("realpath", { sandboxPath: "/home/user/project" })).text, root);
    for (const p of [
      "/home/user/project/../outside.txt",
      "/home/user/project-other/b.txt",
      "/home/user/project/..\\outside.txt",
      "/home/user/project/C:/Windows/win.ini",
      "/etc/passwd",
      "/home/user/project/a\0b",
    ]) {
      const r = await call("realpath", { sandboxPath: p });
      assert.equal(r.isError, true, `expected rejection for ${JSON.stringify(p)}, got ${r.text}`);
    }
  }));

test("path_exists sees overlay writes, never reaches outside the root, never writes to disk", () =>
  withServer({}, async ({ call }) => {
    assert.equal((await call("path_exists", { sandboxPath: "/home/user/project/a.txt" })).text, "true");
    for (const p of ["/home/user/project/../outside.txt", "/home/user/project/..\\outside.txt", "/home/user/project-other/b.txt"]) {
      assert.equal((await call("path_exists", { sandboxPath: p })).isError, true, p);
    }
    assert.equal((await call("bash_exec", { script: "echo v > virt.txt" })).isError, false);
    assert.equal((await call("path_exists", { sandboxPath: "/home/user/project/virt.txt" })).text, "true");
    assert.equal(existsSync(join(root, "virt.txt")), false, "overlay write leaked to disk");
  }));

test("bash_exec cannot read outside the mounted root", () =>
  withServer({}, async ({ call }) => {
    const r = await call("bash_exec", { script: "cat ../outside.txt" });
    assert.equal(r.isError, true);
    assert.doesNotMatch(r.text, /^outside$/m);
  }));

test("invalid timeout falls back to the default instead of a 1ms timer", () =>
  withServer({}, async ({ call, stderr }) => {
    const r = await call("bash_exec", { script: "echo ok", timeout: "x" });
    assert.match(r.text, /ok/);
    assert.doesNotMatch(stderr(), /TimeoutNaNWarning/);
  }));

test("faf_sync and faf_moltbot_sync are hidden and refused unless opted in", () =>
  withServer({}, async ({ call, list }) => {
    const names = await list();
    assert.ok(!names.includes("faf_sync") && !names.includes("faf_moltbot_sync"));
    assert.ok(names.includes("faf_score") && names.includes("faf_migrate"));
    const r = await call("faf_sync", { project: root });
    assert.equal(r.isError, true);
    assert.match(r.text, /JUST_BASH_ENABLE_FAF_SYNC/);
  }));

test("faf tools validate the project and pass paths as single safe arguments", () =>
  withServer({ JUST_BASH_ENABLE_FAF_SYNC: "1" }, async ({ call, list }) => {
    assert.ok((await list()).includes("faf_moltbot_sync"));
    const spaced = join(fx, "proj with space");
    assert.deepEqual(argvOf((await call("faf_moltbot_sync", { project: spaced })).text).argv, ["sync", "-w", spaced]);
    assert.equal(argvOf((await call("faf_score", { project: spaced })).text).cwd, spaced);
    assert.match((await call("faf_score", { project: "relative/dir" })).text, /absolute/);
    assert.match((await call("faf_score", { project: join(fx, "missing") })).text, /does not exist/);
    assert.match((await call("faf_score", { project: join(root, "a.txt") })).text, /not a directory/);
    if (isWin) {
      const amp = join(fx, "proj&echo INJECTED");
      const r = await call("faf_moltbot_sync", { project: amp });
      assert.deepEqual(argvOf(r.text).argv, ["sync", "-w", amp]);
      // An injected `echo INJECTED` would print a bare line; the path itself only appears inside JSON/header.
      assert.doesNotMatch(r.text, /^INJECTED\s*$/m);
      // Trailing backslash must not swallow the closing quote.
      assert.deepEqual(argvOf((await call("faf_moltbot_sync", { project: join(fx, "stub") + "\\" })).text).argv, ["sync", "-w", join(fx, "stub")]);
    }
  }));
