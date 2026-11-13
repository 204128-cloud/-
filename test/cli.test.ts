import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { findGitExecutable } from "../src/git.ts";
import { executionEnvironment, runProcess } from "../src/process.ts";
import { loadTask } from "../src/task.ts";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
async function runCli(...args: string[]) {
  return runCliWithNodeArgs([], args);
}

async function runCliWithNodeArgs(nodeArgs: string[], args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, PI_OFFLINE: "1" };
  delete env.DASHSCOPE_API_KEY;
  const execution = promisify(execFile)(process.execPath, [...nodeArgs, cli, ...args], { env, timeout: 20_000, windowsHide: true });
  execution.child.stdin?.end();
  return execution;
}

test("help describes only implemented commands", async () => {
  const { stdout } = await runCli("--help");
  assert.match(stdout, /check/);
  assert.match(stdout, /smoke/);
  assert.match(stdout, /verify <task\.json> <patch\.diff>/);
  assert.match(stdout, /propose <task\.json>/);
  assert.match(stdout, /locate <task\.json>/);
  assert.match(stdout, /repair <task\.json>/);
  assert.match(stdout, /bench <suite\.json>/);
  assert.match(stdout, /chat \[task\.json\]/);
  assert.match(stdout, /tui \[task\.json\]/);
  assert.match(stdout, /task init \[repoPath\]/);
  assert.match(stdout, /shared first candidate/);
  assert.match(stdout, /explicit review/);
});

test("task initialization validates arguments and requires interactive stdin without a credential", async () => {
  for (const args of [["task"], ["task", "other"], ["task", "init", "repo", "extra"]]) {
    await assert.rejects(runCli(...args), error => {
      assert.ok(error instanceof Error && "code" in error && "stderr" in error);
      assert.equal(error.code, 2);
      const result = JSON.parse(String(error.stderr));
      assert.equal(result.kind, "task_initialization");
      assert.equal(result.code, "USAGE");
      return true;
    });
  }
  await assert.rejects(runCli("task", "init"), error => {
    assert.ok(error instanceof Error && "stderr" in error);
    const result = JSON.parse(String(error.stderr));
    assert.equal(result.kind, "task_initialization");
    assert.equal(result.code, "TTY_REQUIRED");
    return true;
  });
});

test("task initialization allows redirected stdout and reaches the wizard without authentication", async () => {
  const wizard = `export async function runTaskWizard(repoPath) {
    return {kind:'task_initialization', status:'cancelled', taskPath:repoPath ?? null, precheck:null};
  }`;
  const preload = `
    import { registerHooks } from 'node:module'; process.stdin.isTTY=true;
    registerHooks({resolve(specifier, context, nextResolve) {
      if (specifier === './task-wizard.ts') return {url:${JSON.stringify(`data:text/javascript,${encodeURIComponent(wizard)}`)},shortCircuit:true};
      return nextResolve(specifier,context);
    }});
  `;
  const { stdout } = await runCliWithNodeArgs(["--import", `data:text/javascript,${encodeURIComponent(preload)}`], ["task", "init", "repo with spaces"]);
  assert.deepEqual(JSON.parse(stdout), { kind: "task_initialization", status: "cancelled", taskPath: "repo with spaces", precheck: null });
});

test("the real CLI wizard creates a usable task and runs an explicitly requested baseline without a key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "repopilot-wizard-cli-"));
  const repository = join(directory, "repository");
  const output = join(directory, "saved task.json");
  const env = executionEnvironment();
  const executable = await findGitExecutable(env);
  assert.ok(executable);
  let reportPath: string | undefined;
  async function git(args: string[]) {
    const result = await runProcess(executable!, args, { cwd: repository, env, timeoutMs: 15_000, captureOutput: true });
    assert.equal(result.exitCode, 0, "Wizard fixture Git operation must succeed");
    return result.stdout.trim();
  }
  try {
    await cp(fileURLToPath(new URL("../cases/pagination-empty/", import.meta.url)), repository, { recursive: true });
    await git(["init", "--initial-branch=main"]);
    await git(["add", "."]);
    await git(["-c", "user.name=RepoPilot Test Fixture", "-c", "user.email=fixture@localhost", "-c",
      `core.hooksPath=${join(directory, "no-hooks")}`, "commit", "--quiet", "-m", "Wizard fixture"]);
    const dialogue: [RegExp, string][] = [
      [/任务编号 \[[^\n]*：/, "wizard-cli"],
      [/问题描述[^\n]*：/, "paginate returns zero pages for empty input"],
      [/复现脚本编号：/, "2"],
      [/回归脚本编号[^\n]*：/, "1"],
      [/失败测试完整名称[^\n]*：/, "paginate returns zero pages for empty input"],
      [/允许修改的文件编号[^\n]*：/, "1"],
      [/输出 JSON 路径[^\n]*：/, output],
      [/输入 yes 保存[^\n]*：/, "yes"],
      [/现在准备依赖[^\n]*：/, "yes"],
    ];
    const childEnv = { ...process.env, PI_OFFLINE: "1" };
    delete (childEnv as NodeJS.ProcessEnv).DASHSCOPE_API_KEY;
    const execution = promisify(execFile)(process.execPath, ["--import", "data:text/javascript,process.stdin.isTTY=true", cli,
      "task", "init", repository], { timeout: 60_000, windowsHide: true, env: childEnv });
    let pending = "";
    execution.child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      pending += chunk;
      const [prompt, answer] = dialogue[0] ?? [];
      const match = prompt?.exec(pending);
      if (match) {
        pending = pending.slice(match.index + match[0].length);
        dialogue.shift();
        execution.child.stdin?.write(answer + "\n");
      }
    });
    const { stdout } = await execution;
    const result = JSON.parse(stdout);
    reportPath = result.precheck?.reportPath;
    assert.equal(dialogue.length, 0);
    assert.equal(result.status, "created");
    assert.equal(result.taskPath, output);
    assert.equal(result.precheck?.baselineStatus, "ready");
    const task = await loadTask(output);
    assert.equal(task.baseCommit, await git(["rev-parse", "HEAD"]));
    assert.deepEqual(task.allowedPaths, ["src/paginate.ts"]);
    assert.equal(await git(["status", "--porcelain=v1"]), "");
  } finally {
    if (reportPath) {
      const runDirectory = dirname(reportPath);
      assert.equal(dirname(runDirectory), resolve(fileURLToPath(new URL("../.repopilot/runs/", import.meta.url))));
      const report = JSON.parse(await readFile(reportPath, "utf8"));
      if (report.artifacts.worktree) {
        assert.equal(resolve(report.artifacts.worktree), join(runDirectory, "worktree"));
        await git(["worktree", "remove", "--force", report.artifacts.worktree]);
      }
      await rm(runDirectory, { recursive: true, force: true });
    }
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("chat requires an interactive terminal before model or task setup", async () => {
  for (const args of [[], ["missing-task.json"]]) {
    await assert.rejects(runCli("chat", ...args), error => {
      assert.ok(error instanceof Error && "code" in error && "stderr" in error);
      assert.equal(error.code, 2);
      const result = JSON.parse(String(error.stderr));
      assert.equal(result.kind, "terminal_chat");
      assert.equal(result.code, "TTY_REQUIRED");
      return true;
    });
  }
});

test("tui requires both stdin and stdout to be interactive before model or task setup", async () => {
  for (const interactive of ["stdin", "stdout"]) {
    const preload = `data:text/javascript,process.${interactive}.isTTY=true`;
    await assert.rejects(runCliWithNodeArgs(["--import", preload], ["tui", "missing-task.json"]), error => {
      assert.ok(error instanceof Error && "code" in error && "stderr" in error);
      assert.equal(error.code, 2);
      const result = JSON.parse(String(error.stderr));
      assert.equal(result.kind, "terminal_tui");
      assert.equal(result.status, "error");
      assert.equal(result.code, "TTY_REQUIRED");
      return true;
    });
  }
});

test("tui rejects extra or blank task arguments before checking the terminal", async () => {
  for (const args of [["tasks/example.json", "extra.json"], [" "]]) {
    await assert.rejects(runCli("tui", ...args), error => {
      assert.ok(error instanceof Error && "code" in error && "stderr" in error);
      assert.equal(error.code, 2);
      const result = JSON.parse(String(error.stderr));
      assert.equal(result.kind, "terminal_tui");
      assert.equal(result.code, "USAGE");
      return true;
    });
  }
});

function tuiNodeArgs(tuiStub: string) {
  const preload = `
    import { registerHooks } from 'node:module';
    process.stdin.isTTY = process.stdout.isTTY = true;
    registerHooks({resolve(specifier, context, nextResolve) {
      if (specifier === './chat-tui.ts') return {url: ${JSON.stringify(`data:text/javascript,${encodeURIComponent(tuiStub)}`)}, shortCircuit: true};
      return nextResolve(specifier, context);
    }});
  `;
  return ["--import", `data:text/javascript,${encodeURIComponent(preload)}`];
}

test("interactive tui passes the optional task path to the full-screen chat", async () => {
  const nodeArgs = tuiNodeArgs(`
    export async function runChatTui(taskFile) {
      process.stdout.write(taskFile ?? 'no task');
    }
  `);
  for (const [args, expected] of [[[], "no task"], [["tasks/my example.json"], "tasks/my example.json"]] as const) {
    const { stdout } = await runCliWithNodeArgs(nodeArgs, ["tui", ...args]);
    assert.equal(stdout, expected);
  }
});

test("tui startup errors omit raw exception details", async () => {
  const nodeArgs = tuiNodeArgs(`export async function runChatTui() { throw new Error('raw startup details'); }`);
  await assert.rejects(runCliWithNodeArgs(nodeArgs, ["tui"]), error => {
    assert.ok(error instanceof Error && "code" in error && "stderr" in error);
    assert.equal(error.code, 2);
    assert.doesNotMatch(String(error.stderr), /raw startup details/);
    const result = JSON.parse(String(error.stderr));
    assert.equal(result.kind, "terminal_tui");
    assert.equal(result.status, "error");
    assert.equal(result.code, "TUI_ERROR");
    return true;
  });
});

test("interactive chat queues one image and asks separately before execution and review", async () => {
  const directory = await mkdtemp(join(tmpdir(), "repopilot-cli-"));
  const image = join(directory, "small image.png");
  await writeFile(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/G1sAAAAASUVORK5CYII=", "base64"));

  const chatStub = `
    export async function createChat({taskFile, confirmAction, review, onReport}) {
      if (taskFile !== 'tasks/example.json') throw new Error('missing task');
      return {taskId: 'example', reset() {}, async send(text, image) {
        if (text === 'repair question' && await confirmAction('repair')) {
          const approved = await review({attempt: 1, patchPath: 'candidate.diff', candidateHash: 'test-hash'});
          if (approved) onReport({status: 'resolved', reportPath: 'repair.json', patchPath: 'candidate.diff'});
        }
        return text + ' / image: ' + (image?.mimeType ?? 'none');
      }};
    }
  `;
  const preload = `
    import { registerHooks } from 'node:module';
    process.stdin.isTTY = true;
    registerHooks({resolve(specifier, context, nextResolve) {
      if (specifier === './chat.ts') return {url: ${JSON.stringify(`data:text/javascript,${encodeURIComponent(chatStub)}`)}, shortCircuit: true};
      return nextResolve(specifier, context);
    }});
  `;
  const dialogue: [RegExp, string][] = [
    [/你> /, `/image "${image}"`],
    [/你> /, "repair question"],
    [/执行.*yes/, "yes"],
    [/补丁审阅.*yes/, "yes"],
    [/你> /, "follow-up"],
    [/你> /, `/image ${image}`],
    [/你> /, `/image ${image}.missing`],
    [/你> /, "after failed replacement"],
    [/你> /, "/exit"],
  ];
  try {
    const execution = promisify(execFile)(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, cli, "chat", "tasks/example.json"], { timeout: 20_000, windowsHide: true });
    let pending = "";
    execution.child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      pending += chunk;
      const [prompt, answer] = dialogue[0] ?? [];
      const match = prompt?.exec(pending);
      if (match) {
        pending = pending.slice(match.index + match[0].length);
        dialogue.shift();
        execution.child.stdin?.write(answer + "\n");
      }
    });
    const { stdout, stderr } = await execution;
    assert.equal(dialogue.length, 0);
    assert.match(stdout, /repair question \/ image: image\/png/);
    assert.match(stdout, /follow-up \/ image: none/);
    assert.match(stdout, /after failed replacement \/ image: none/);
    assert.match(stderr, /发送.*模型服务/);
    assert.match(stderr, /repair\.json/);
    assert.ok(!stderr.includes(image) && !stdout.includes(image));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function syntheticSessionChat(chatStub: string, storeStub: string, dialogue: [RegExp, string | undefined][], extraModules: Record<string, string> = {}) {
  const modules = { "./chat.ts": chatStub, "./session-store.ts": storeStub, ...extraModules };
  const preload = `
    import { registerHooks } from 'node:module';
    process.stdin.isTTY = true;
    const modules = ${JSON.stringify(Object.fromEntries(Object.entries(modules).map(([name, source]) => [name, `data:text/javascript,${encodeURIComponent(source)}`])))};
    registerHooks({resolve(specifier, context, nextResolve) {
      if (modules[specifier]) return {url: modules[specifier], shortCircuit: true};
      return nextResolve(specifier, context);
    }});
  `;
  const env: NodeJS.ProcessEnv = { ...process.env, PI_OFFLINE: "1" };
  delete env.DASHSCOPE_API_KEY;
  const execution = promisify(execFile)(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, cli, "chat"], {
    timeout: 20_000, windowsHide: true, env,
  });
  let pending = "";
  execution.child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    pending += chunk;
    const [prompt, answer] = dialogue[0] ?? [];
    const match = prompt?.exec(pending);
    if (match) {
      pending = pending.slice(match.index + match[0].length);
      dialogue.shift();
      if (answer === undefined) execution.child.stdin?.end();
      else execution.child.stdin?.write(answer + "\n");
    }
  });
  const result = await execution;
  assert.equal(dialogue.length, 0);
  return result;
}

test("plain chat shows attachment metadata and clears only the pending image without sending local commands", async () => {
  const directory = await mkdtemp(join(tmpdir(), "repopilot-attachment-cli-"));
  const image = join(directory, "attached photo.png");
  const bytes = Buffer.from("89504e470d0a1a0a7465737420696d616765", "hex");
  await writeFile(image, bytes);
  const chatStub = `
    export async function createChat() { let index=0; let resets=0; return {
      taskId:null, reset(){resets++;}, snapshot(){return {task:null,turns:[{user:'earlier',assistant:'answer',hadImage:false,reports:[]}]};},
      async restore(){throw new Error('unexpected restore');},
      async send(text,image) {
        const expected=[['after local commands',true],['after clear',false],['fail once',true],['retry',true],['after failed replacement',false],['after invalid replacement',false],['after reset',false]][index++];
        if(!expected||text!==expected[0]||Boolean(image)!==expected[1])throw new Error('unexpected provider request');
        if(resets!==(text==='after reset'?1:0))throw new Error('attachment commands changed conversation history');
        if(image&&Object.keys(image).sort().join(',')!=='data,mimeType,type')throw new Error('attachment metadata reached provider');
        if(text==='fail once')throw new Error('synthetic model failure');
        return text+' / image: '+(image?.mimeType??'none');
      }
    }; }
  `;
  const storeStub = `
    export class SessionError extends Error {}
    export async function saveSession(){return {id:'12345678-1234-4234-9234-123456789abc'};}
    export async function listSessions(){return [];}
    export async function loadSession(){throw new Error('unexpected load');}
  `;
  try {
    const { stdout, stderr } = await syntheticSessionChat(chatStub, storeStub, [
      [/你> /, "/image"], [/你> /, `/image "${image}"`], [/你> /, "/image"],
      [/你> /, "/help"], [/你> /, "/save"], [/你> /, "/sessions"], [/你> /, "after local commands"],
      [/你> /, "/image"], [/你> /, `/image "${image}"`], [/你> /, "/image clear"],
      [/你> /, "/image"], [/你> /, "after clear"], [/你> /, `/image "${image}"`],
      [/你> /, "fail once"], [/你> /, "/image"], [/你> /, "retry"],
      [/你> /, `/image "${image}"`], [/你> /, `/image "${image}.missing"`], [/你> /, "/image"],
      [/你> /, "after failed replacement"], [/你> /, `/image "${image}"`],
      [/你> /, "/image https://example.invalid/a.png"], [/你> /, "after invalid replacement"],
      [/你> /, `/image "${image}"`], [/你> /, "/reset"],
      [/你> /, "/image"], [/你> /, "after reset"], [/你> /, "/exit"],
    ]);
    assert.match(stderr, new RegExp(`attached photo\\.png.*PNG.*${bytes.length} B`));
    assert.match(stderr, /待发送图片已移除/);
    assert.match(stderr, /当前无待发送图片/);
    assert.match(stderr, /\/image clear/);
    assert.match(stdout, /after local commands \/ image: image\/png/);
    assert.match(stdout, /after clear \/ image: none/);
    assert.match(stdout, /retry \/ image: image\/png/);
    assert.match(stdout, /after failed replacement \/ image: none/);
    assert.match(stdout, /after invalid replacement \/ image: none/);
    assert.match(stdout, /after reset \/ image: none/);
    assert.ok(!stdout.includes(image) && !stderr.includes(image));
    assert.ok(!stdout.includes(bytes.toString("base64")) && !stderr.includes(bytes.toString("base64")));
    assert.doesNotMatch(stdout + stderr, /unexpected provider request|attachment metadata reached provider|synthetic model failure|attachment commands changed conversation history/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("plain chat supports pasted image questions and local queuing without sending file paths as prompts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "repopilot-inline-cli-"));
  const image = join(directory, "微信图片 inline.png");
  const data = "89504e470d0a1a0a7465737420696d616765";
  await writeFile(image, Buffer.from(data, "hex"));
  const chatStub = `export async function createChat(){return{taskId:null,reset(){},async send(text,image){
    if(image && (image.mimeType!=='image/png'||Buffer.from(image.data,'base64').toString('hex')!==${JSON.stringify(data)}))throw new Error('wrong image bytes');
    return text+' / image: '+(image?.mimeType??'none');
  }}}`;
  try {
    const { stdout, stderr } = await syntheticSessionChat(chatStub, "", [
      [/你> /, `"${image}"描述一下这张图片`],
      [/你> /, `"${image}"`], [/你> /, "/image"], [/你> /, "解释刚才附上的图片"],
      [/你> /, `"${join(directory, 'missing.png')}"描述图片`], [/你> /, "之后的文字问题"], [/你> /, "/exit"],
    ]);
    assert.match(stdout, /描述一下这张图片 \/ image: image\/png/);
    assert.match(stdout, /解释刚才附上的图片 \/ image: image\/png/);
    assert.match(stdout, /之后的文字问题 \/ image: none/);
    assert.match(stderr, /图片已就绪/);
    assert.match(stderr, /无法读取图片文件/);
    assert.ok(!stdout.includes(directory));
    assert.equal(stdout.trim().split("\n").length, 3);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("plain chat saves and lists sessions locally and restores only after confirmation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "repopilot-session-cli-"));
  const image = join(directory, "local image.png");
  await writeFile(image, Buffer.from("89504e470d0a1a0a7465737420696d616765", "hex"));
  const id = "12345678-1234-4234-9234-123456789abc";
  const snapshot = { task: null, turns: [{ user: "历史问题", assistant: "历史回答", hadImage: true,
    reports: [{ status: "resolved", reportPath: "historical-report.json", patchPath: "historical-patch.diff" }] }] };
  const chatStub = `
    let restored = false;
    export async function createChat() {
      return { taskId:null, reset() { restored=false; }, snapshot() { return ${JSON.stringify(snapshot)}; },
        async restore(snapshot,signal) { if(snapshot.turns[0].user!=='历史问题'||!(signal instanceof AbortSignal)) throw new Error('bad restore'); restored=true; },
        async send(text,image) { return text+' / image: '+(image?.mimeType??'none')+' / restored: '+restored; }
      };
    }
  `;
  const storeStub = `
    export class SessionError extends Error {}
    const session={version:1,id:${JSON.stringify(id)},createdAt:'2026-11-11T10:00:00.000Z',...${JSON.stringify(snapshot)}};
    export async function saveSession(snapshot) { if(snapshot.turns[0].user!=='历史问题') throw new Error('bad snapshot'); return session; }
    export async function listSessions() { return [{id:session.id,createdAt:session.createdAt,taskId:null,turns:1}]; }
    export async function loadSession(id) { if(id!==session.id) throw new Error('bad id'); return session; }
  `;
  try {
    const { stdout, stderr } = await syntheticSessionChat(chatStub, storeStub, [
      [/你> /, "/help"], [/你> /, "/save"], [/你> /, "/sessions"],
      [/你> /, `/image "${image}"`], [/你> /, `/resume ${id}`], [/恢复.*yes/, "no"],
      [/你> /, "after declined restore"], [/你> /, `/image "${image}"`],
      [/你> /, `/resume ${id}`], [/恢复.*yes/, "yes"], [/你> /, "after accepted restore"],
      [/你> /, "/reset"], [/你> /, "/sessions"], [/你> /, "/exit"],
    ]);
    assert.match(stderr, /\/save/);
    assert.match(stderr, /\/sessions/);
    assert.match(stderr, /\/resume/);
    assert.match(stderr, new RegExp(id));
    assert.match(stderr, /已保存/);
    assert.match(stderr, /已恢复/);
    assert.match(stdout, /after declined restore \/ image: image\/png \/ restored: false/);
    assert.match(stdout, /after accepted restore \/ image: none \/ restored: true/);
    assert.match(stdout + stderr, /历史问题/);
    assert.match(stdout + stderr, /历史回答/);
    assert.match(stdout + stderr, /图片未恢复/);
    assert.match(stdout + stderr, /历史报告引用/);
    assert.match(stdout + stderr, /historical-report\.json/);
    assert.ok(!stdout.includes("/save / image") && !stdout.includes("/sessions / image"));
    assert.ok(!stdout.includes("/resume "));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("plain chat session failures keep the current image and hide raw storage exceptions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "repopilot-session-cli-error-"));
  const image = join(directory, "image.png");
  await writeFile(image, Buffer.from("89504e470d0a1a0a7465737420696d616765", "hex"));
  const chatStub = `export async function createChat() { return {taskId:null,reset(){},snapshot(){throw new Error('must not save');},
    async restore(){throw new Error('must not restore');},async send(text,image){return text+' / image: '+(image?.mimeType??'none');}}; }`;
  const storeStub = `
    export class SessionError extends Error {}
    export async function saveSession(){throw new Error('must not save');}
    export async function listSessions(){return [];}
    export async function loadSession(id){if(id==='corrupt')throw new SessionError('会话文件无效。');if(id==='mismatch')return {task:null,turns:[]};throw new Error('raw-private-storage-error');}
  `;
  try {
    const { stdout, stderr } = await syntheticSessionChat(chatStub, storeStub, [
      [/你> /, `/image "${image}"`], [/你> /, "/resume corrupt"], [/你> /, "after failed restore"],
      [/你> /, "/resume raw"], [/你> /, `/image "${image}"`], [/你> /, "/resume mismatch"],
      [/恢复.*yes/, "yes"], [/你> /, "after incompatible restore"], [/你> /, "/resume"], [/你> /, "/save extra"],
      [/你> /, "/sessions extra"], [/你> /, "/sessions"], [/你> /, "/exit"],
    ]);
    assert.match(stdout, /after failed restore \/ image: image\/png/);
    assert.match(stdout, /after incompatible restore \/ image: image\/png/);
    assert.match(stderr, /会话文件无效/);
    assert.match(stderr, /会话操作失败/);
    assert.match(stderr, /用法/);
    assert.match(stderr, /暂无已保存会话/);
    assert.doesNotMatch(stdout + stderr, /raw-private-storage-error|must not (?:save|restore)/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("plain chat refuses an empty save before writing and remains ready for a question", async () => {
  const directory = await mkdtemp(join(tmpdir(), "repopilot-session-cli-empty-"));
  const savedFile = join(directory, "must-not-exist.json");
  const chatStub = `
    export async function createChat() { let calls=0; return {taskId:null,reset(){},snapshot(){return {task:null,turns:[]};},
      async restore(){throw new Error('unexpected restore');},async send(text){
        if(++calls!==1||text!=='继续提问')throw new Error('unexpected model call');return '唯一的普通回答';
      }};
    }
  `;
  const storeStub = `
    import {writeFile} from 'node:fs/promises';
    export class SessionError extends Error {}
    export async function saveSession(){await writeFile(${JSON.stringify(savedFile)},'unexpected save');return {id:'unexpected-session'};}
    export async function listSessions(){return [];}
    export async function loadSession(){throw new Error('unexpected load');}
  `;
  try {
    const { stdout, stderr } = await syntheticSessionChat(chatStub, storeStub, [
      [/你> /, "/save"], [/你> /, "继续提问"], [/你> /, "/exit"],
    ]);
    assert.match(stderr, /请先完成一轮对话再保存/);
    await assert.rejects(readFile(savedFile), { code: "ENOENT" });
    assert.equal(stdout.trim(), "唯一的普通回答");
    assert.doesNotMatch(stderr, /unexpected-session|已保存会话/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("plain chat shows status locally, validates arguments and preserves a pending image on status errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "repopilot-status-cli-"));
  const image = join(directory, "status.png");
  await writeFile(image, Buffer.from("89504e470d0a1a0a7465737420696d616765", "hex"));
  const chatStub = `
    export async function createChat() { let reads=0,calls=0;return {taskId:null,
      reset(){throw new Error('unexpected reset');},snapshot(){throw new Error('unexpected snapshot');},
      status(){if(++reads>1)throw new Error('private-status-error');return {model:'dashscope/qwen3.7-plus',endpoint:'https://example.test/v1',imageInput:true,taskId:null};},
      async send(text,image){if(++calls!==1||text!=='继续提问'||image?.mimeType!=='image/png')throw new Error('unexpected request');return '状态之后的图片回答';}
    };}
  `;
  try {
    const { stdout, stderr } = await syntheticSessionChat(chatStub, "", [
      [/你> /, `/image "${image}"`], [/你> /, "/help"], [/你> /, "/status extra"],
      [/你> /, "/status"], [/你> /, "/status"], [/你> /, "继续提问"], [/你> /, "/exit"],
    ]);
    assert.equal(stdout.trim(), "状态之后的图片回答");
    assert.match(stderr, /\/status/);
    assert.match(stderr, /用法：\/status/);
    assert.match(stderr, /当前会话状态.*离线/);
    assert.match(stderr, /https:\/\/example\.test\/v1/);
    assert.match(stderr, /已加载，未验证鉴权/);
    assert.match(stderr, /无法读取当前会话状态/);
    assert.doesNotMatch(stdout + stderr, /private-status-error|unexpected|输入 yes|未知对话命令/);
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); await rm(directory, { recursive: true, force: true });
  }
});

test("plain chat runs offline doctor without model requests or consuming pending images", async () => {
  const directory = await mkdtemp(join(tmpdir(), "repopilot-doctor-cli-"));
  const image = join(directory, "doctor.png");
  await writeFile(image, Buffer.from("89504e470d0a1a0a7465737420696d616765", "hex"));
  const chatStub = `export async function createChat(){let reads=0;return {taskId:null,
    reset(){throw new Error('unexpected reset');},
    async doctor(signal){if(!(signal instanceof AbortSignal)||signal.aborted)throw new Error('bad signal');if(++reads>1)throw new Error('raw-private-diagnosis');return {checks:[{name:'模型配置',status:'warning',message:'配置变化，请重启聊天'}]};},
    async send(text,image){if(text!=='继续提问'||!image)throw new Error('unexpected provider request');return '诊断后图片回答';}
  };}`;
  try {
    const { stdout, stderr } = await syntheticSessionChat(chatStub, "", [
      [/你> /, `/image "${image}"`], [/你> /, "/help"], [/你> /, "/doctor extra"],
      [/你> /, "/doctor"], [/你> /, "/doctor"], [/你> /, "继续提问"], [/你> /, "/exit"],
    ]);
    assert.equal(stdout.trim(), "诊断后图片回答");
    assert.match(stderr, /用法：\/doctor/);
    assert.match(stderr, /离线诊断.*未联网/);
    assert.match(stderr, /配置变化，请重启聊天/);
    assert.match(stderr, /离线诊断未完成/);
    assert.doesNotMatch(stdout + stderr, /raw-private-diagnosis|unexpected|输入 yes|未知对话命令/);
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); await rm(directory, { recursive: true, force: true });
  }
});

test("closing plain chat aborts offline diagnosis and hides a late result", async () => {
  const chatStub = `export async function createChat(){return {taskId:null,
    async doctor(signal){process.stderr.write('DOCTOR_PENDING\\n');await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));return {checks:[{name:'配置',status:'ok',message:'LATE_CLI_DIAGNOSIS'}]};},
    async send(){throw new Error('unexpected request');}
  };}`;
  const { stdout, stderr } = await syntheticSessionChat(chatStub, "", [[/你> /, "/doctor"], [/DOCTOR_PENDING/, undefined]]);
  assert.equal(stdout, "");
  assert.doesNotMatch(stderr, /LATE_CLI_DIAGNOSIS|诊断未完成|unexpected/);
});

test("plain chat authentication confirms each request and preserves pending images through refusal and errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "repopilot-auth-cli-"));
  const image = join(directory, "auth.png");
  await writeFile(image, Buffer.from("89504e470d0a1a0a7465737420696d616765", "hex"));
  const chatStub = `export async function createChat(){let probes=0;return {taskId:null,
    status(){return {model:'dashscope/qwen3.7-plus',endpoint:'https://example.test/v1',imageInput:true,taskId:null};},
    async authCheck(signal){if(!signal||signal.aborted)throw new Error('bad signal');if(++probes>1)throw new Error('raw-private-auth-error');return {status:'rejected',httpStatus:401,serviceCode:'invalid_api_key'};},
    async send(text,image){if(probes!==2||text!=='继续提问'||!image)throw new Error('unexpected request or missing confirmation');return '联网之后的图片回答';}
  };}`;
  try {
    const { stdout, stderr } = await syntheticSessionChat(chatStub, "", [
      [/你> /, `/image "${image}"`], [/你> /, "/help"], [/你> /, "/auth-check extra"],
      [/你> /, "/auth-check"], [/输入 yes 执行一次联网检查[^：]*：/, "no"],
      [/你> /, "/auth-check"], [/输入 yes 执行一次联网检查[^：]*：/, "yes"],
      [/你> /, "/auth-check"], [/输入 yes 执行一次联网检查[^：]*：/, "yes"],
      [/你> /, "继续提问"], [/你> /, "/exit"],
    ]);
    assert.equal(stdout.trim(), "联网之后的图片回答");
    assert.match(stderr, /用法：\/auth-check/); assert.match(stderr, /未发送联网检查请求/);
    assert.match(stderr, /Reply OK\./); assert.match(stderr, /可能产生少量费用/);
    assert.match(stderr, /HTTP 401/); assert.match(stderr, /invalid_api_key/);
    assert.match(stderr, /联网检查未完成/);
    assert.doesNotMatch(stdout + stderr, /raw-private-auth-error|unexpected|未知对话命令/);
  } finally { assert.equal(dirname(resolve(directory)), resolve(tmpdir())); await rm(directory, { recursive: true, force: true }); }
});

test("closing plain chat during authentication confirmation sends no request", async () => {
  const chatStub = `export async function createChat(){return {taskId:null,
    status(){return {model:'dashscope/qwen3.7-plus',endpoint:'https://example.test/v1',imageInput:false,taskId:null};},
    async authCheck(){throw new Error('unexpected auth call');},async send(){throw new Error('unexpected request');}
  };}`;
  const { stdout, stderr } = await syntheticSessionChat(chatStub, "", [[/你> /, "/auth-check"], [/输入 yes 执行一次联网检查[^：]*：/, undefined]]);
  assert.equal(stdout, ""); assert.doesNotMatch(stderr, /unexpected|HTTP|检查未完成/);
});

test("closing plain chat during an active authentication request aborts it and hides the result", async () => {
  const chatStub = `export async function createChat(){return {taskId:null,
    status(){return {model:'dashscope/qwen3.7-plus',endpoint:'https://example.test/v1',imageInput:false,taskId:null};},
    async authCheck(signal){process.stderr.write('AUTH_PENDING\\n');await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));return {status:'accepted',httpStatus:200};},
    async send(){throw new Error('unexpected request');}
  };}`;
  const { stdout, stderr } = await syntheticSessionChat(chatStub, "", [[/你> /, "/auth-check"], [/输入 yes 执行一次联网检查[^：]*：/, "yes"], [/AUTH_PENDING/, undefined]]);
  assert.equal(stdout, ""); assert.doesNotMatch(stderr, /HTTP 200|检查未完成|unexpected/);
});

test("plain chat lists and opens run history locally without consuming an attachment or changing the conversation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "repopilot-run-cli-"));
  const image = join(directory, "pending image.png");
  const bytes = Buffer.from("89504e470d0a1a0a7465737420696d616765", "hex");
  await writeFile(image, bytes);
  const chatStub = `
    export async function createChat() { let calls=0; return {taskId:null,
      reset(){throw new Error('history changed conversation');},snapshot(){throw new Error('history read conversation');},
      async restore(){throw new Error('history restored conversation');},
      async send(text,image){if(++calls!==1||text!=='正常提问'||image?.mimeType!=='image/png')throw new Error('unexpected provider request');return '正常回答，图片保留';}
    }; }
  `;
  const historyStub = `
    export class RunHistoryError extends Error {}
    function check(options){if(!(options.signal instanceof AbortSignal)||options.signal.aborted||options.apiKey!==undefined)throw new Error('invalid read options');}
    export async function listRuns(options){check(options);return {runs:[{id:'repair-Ab12Cd'}],unavailable:0};}
    export async function loadRun(id,options){check(options);if(id!=='repair-Ab12Cd')throw new Error('unexpected id');return {id,status:'resolved'};}
  `;
  const displayStub = `
    export function formatRunList(result){if(result.runs[0].id!=='repair-Ab12Cd')throw new Error('bad list');return '本地运行：repair-Ab12Cd';}
    export function formatRunDetail(detail){if(detail.status!=='resolved')throw new Error('bad detail');return '运行详情：repair-Ab12Cd，验收通过';}
  `;
  try {
    const { stdout, stderr } = await syntheticSessionChat(chatStub, "", [
      [/你> /, `/image "${image}"`], [/你> /, "/help"], [/你> /, "/runs"],
      [/你> /, "/report repair-Ab12Cd"], [/你> /, "/image"],
      [/你> /, "正常提问"], [/你> /, "/exit"],
    ], { "./run-history.ts": historyStub, "./run-display.ts": displayStub });
    assert.equal(stdout.trim(), "正常回答，图片保留");
    assert.match(stderr, /\/runs/);
    assert.match(stderr, /\/report <运行ID>/);
    assert.match(stderr, /本地运行：repair-Ab12Cd/);
    assert.match(stderr, /运行详情：repair-Ab12Cd，验收通过/);
    assert.match(stderr, /待发送图片：pending image\.png/);
    assert.doesNotMatch(stderr, /输入 yes|补丁审阅|未知对话命令|读取失败/);
    assert.ok(!stdout.includes(image) && !stderr.includes(image));
    assert.ok(!(stdout + stderr).includes(bytes.toString("base64")));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("plain chat rejects run history arguments and hides unknown read errors while preserving the pending image", async () => {
  const directory = await mkdtemp(join(tmpdir(), "repopilot-run-cli-error-"));
  const image = join(directory, "image.png");
  await writeFile(image, Buffer.from("89504e470d0a1a0a7465737420696d616765", "hex"));
  const chatStub = `
    export async function createChat(){let calls=0;return {taskId:null,reset(){throw new Error('unexpected reset');},
      async send(text,image){if(++calls!==1||text!=='继续提问'||!image)throw new Error('unexpected model call');return '继续提问，图片保留';}
    };}
  `;
  const historyStub = `
    export class RunHistoryError extends Error {}
    export async function listRuns(){throw new Error('raw-private-run-error');}
    export async function loadRun(id){if(id==='missing')throw new RunHistoryError('本地运行报告不存在。');throw new Error('raw-private-run-error');}
  `;
  const displayStub = `export function formatRunList(){throw new Error('unexpected format');} export function formatRunDetail(){throw new Error('unexpected format');}`;
  try {
    const { stdout, stderr } = await syntheticSessionChat(chatStub, "", [
      [/你> /, `/image "${image}"`], [/你> /, "/runs extra"], [/你> /, "/report"],
      [/你> /, "/report missing extra"], [/你> /, "/report missing"], [/你> /, "/runs"],
      [/你> /, "/report private"], [/你> /, "继续提问"], [/你> /, "/exit"],
    ], { "./run-history.ts": historyStub, "./run-display.ts": displayStub });
    assert.equal(stdout.trim(), "继续提问，图片保留");
    assert.equal((stderr.match(/用法：\/runs 或 \/report <运行ID>。/g) ?? []).length, 3);
    assert.match(stderr, /本地运行报告不存在/);
    assert.equal((stderr.match(/运行报告读取失败。/g) ?? []).length, 2);
    assert.doesNotMatch(stdout + stderr, /raw-private-run-error|unexpected|输入 yes|补丁审阅/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("plain chat cancels run history reads on input close and suppresses late output", async () => {
  const chatStub = `export async function createChat(){return {taskId:null,async send(){throw new Error('unexpected model call');}};}`;
  const historyStub = `
    export class RunHistoryError extends Error {}
    export async function listRuns({signal}){
      process.stderr.write('READ_PENDING\\n');
      await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
      return {runs:[],unavailable:0};
    }
  `;
  const displayStub = `export function formatRunList(){return 'late-report-must-not-display';}`;
  const { stdout, stderr } = await syntheticSessionChat(chatStub, "", [
    [/你> /, "/runs"], [/READ_PENDING/, undefined],
  ], { "./run-history.ts": historyStub, "./run-display.ts": displayStub });
  assert.equal(stdout, "");
  assert.match(stderr, /READ_PENDING/);
  assert.doesNotMatch(stderr, /late-report-must-not-display|读取失败|unknown|unexpected/);
});

test("CLI loads project configuration without an API request", async () => {
  const { stdout } = await runCli("check");
  const result = JSON.parse(stdout) as { model: string; credential: string };
  assert.equal(result.model, "dashscope/qwen3.7-plus");
  assert.equal(result.credential, "missing");
});

test("unknown commands exit with a usage error", async () => {
  await assert.rejects(runCli("run"), error => {
    assert.ok(error instanceof Error && "code" in error && "stderr" in error);
    assert.equal(error.code, 2);
    assert.match(String(error.stderr), /USAGE/);
    return true;
  });
});

test("verification requires both task and patch arguments", async () => {
  await assert.rejects(runCli("verify"), error => {
    assert.ok(error instanceof Error && "code" in error && "stderr" in error);
    assert.equal(error.code, 2);
    const result = JSON.parse(String(error.stderr)) as { kind: string; status: string; code: string };
    assert.equal(result.kind, "patch_verification");
    assert.equal(result.status, "error");
    assert.equal(result.code, "USAGE");
    return true;
  });
});

test("localization requires a task argument and reports usage without a credential", async () => {
  await assert.rejects(runCli("locate"), error => {
    assert.ok(error instanceof Error && "code" in error && "stderr" in error);
    assert.equal(error.code, 2);
    const result = JSON.parse(String(error.stderr));
    assert.equal(result.kind, "source_localization");
    assert.equal(result.status, "error");
    assert.equal(result.code, "USAGE");
    return true;
  });
});

test("repair requires a task argument before requesting a credential or review", async () => {
  await assert.rejects(runCli("repair"), error => {
    assert.ok(error instanceof Error && "code" in error && "stderr" in error);
    assert.equal(error.code, 2);
    const result = JSON.parse(String(error.stderr));
    assert.equal(result.kind, "repair_run");
    assert.equal(result.status, "error");
    assert.equal(result.code, "USAGE");
    return true;
  });
});

test("benchmark requires a suite argument before requesting a credential or review", async () => {
  await assert.rejects(runCli("bench"), error => {
    assert.ok(error instanceof Error && "code" in error && "stderr" in error);
    assert.equal(error.code, 2);
    const result = JSON.parse(String(error.stderr));
    assert.equal(result.kind, "benchmark_run");
    assert.equal(result.status, "error");
    assert.equal(result.code, "USAGE");
    return true;
  });
});

test("equal benchmark validates its suite argument before a credential or review is requested", async () => {
  for (const args of [["bench-equal"], ["bench-equal", "suite.json", "extra"]]) {
    await assert.rejects(runCli(...args), error => {
      assert.ok(error instanceof Error && "code" in error && "stderr" in error);
      assert.equal(error.code, 2);
      const result = JSON.parse(String(error.stderr));
      assert.equal(result.kind, "benchmark_run"); assert.equal(result.code, "USAGE"); return true;
    });
  }
});

test("equal benchmark CLI dispatches the suite and labels the strategy before candidate review", async () => {
  const stub = `export async function runEqualBenchmark(suite,review){
    if(suite!=='synthetic-suite.json')throw new Error('unexpected suite');
    const approved=await review({taskId:'fixture-task',taskIndex:1,taskCount:1,strategy:'no_feedback',attempt:1,patchPath:'synthetic.diff',candidateHash:'a'.repeat(64),proposalReport:'proposal.json'});
    if(approved)throw new Error('redirected input must not approve');return {status:'incomplete',design:'equal_budget_independent'};
  }`;
  const preload = `import {registerHooks} from 'node:module'; registerHooks({resolve(specifier,context,next){return specifier==='./equal-benchmark.ts'?{url:${JSON.stringify(`data:text/javascript,${encodeURIComponent(stub)}`)},shortCircuit:true}:next(specifier,context);}});`;
  await assert.rejects(runCliWithNodeArgs(["--import", `data:text/javascript,${encodeURIComponent(preload)}`], ["bench-equal", "synthetic-suite.json"]), error => {
    assert.ok(error instanceof Error && "code" in error && "stdout" in error && "stderr" in error);
    assert.equal(error.code, 1); assert.equal(JSON.parse(String(error.stdout)).design, "equal_budget_independent");
    assert.match(String(error.stderr), /无反馈/); assert.match(String(error.stderr), /等待审阅/); return true;
  });
});

