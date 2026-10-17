// shot.mjs 的审计副本：唯一区别是连我自己的 CDP 端口（9421），
// 并且把问题收集得更全（console 全级别 + 异常 + 资源加载失败）。
//
// 用法：node tools/shot-audit.mjs <页面地址> <输出前缀> ['<步骤 JSON>']
const [url, prefix, stepsArg] = process.argv.slice(2);
if (!url || !prefix) {
  console.error("用法：node tools/shot-audit.mjs <url> <out-prefix> [steps-json]");
  process.exit(2);
}
const CDP_PORT = Number(process.env.LINLI_CDP_PORT || 9421);

const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
const targets = await res.json();
const page = targets.find((t) => t.type === "page");
if (!page) throw new Error("没有可用的 page 目标");
const ws = new WebSocket(page.webSocketDebuggerUrl);

let id = 0;
const waiting = new Map();
const problems = [];
ws.addEventListener("message", (e) => {
  const msg = JSON.parse(e.data);
  if (msg.method === "Runtime.exceptionThrown") {
    problems.push("[exception] " + (msg.params?.exceptionDetails?.exception?.description ?? "未知异常"));
  }
  if (msg.method === "Runtime.consoleAPICalled" && msg.params?.type === "error") {
    problems.push("[console.error] " + (msg.params.args?.map((a) => a.value ?? a.description).join(" ")));
  }
  if (msg.method === "Runtime.consoleAPICalled" && msg.params?.type === "warning") {
    problems.push("[console.warn] " + (msg.params.args?.map((a) => a.value ?? a.description).join(" ")));
  }
  if (msg.method === "Log.entryAdded" && msg.params?.entry?.level === "error") {
    problems.push("[log] " + msg.params.entry.text);
  }
  if (msg.id && waiting.has(msg.id)) {
    waiting.get(msg.id)(msg);
    waiting.delete(msg.id);
  }
});
await new Promise((r) => ws.addEventListener("open", r, { once: true }));

function send(method, params = {}) {
  const mid = ++id;
  ws.send(JSON.stringify({ id: mid, method, params }));
  return new Promise((resolve) => waiting.set(mid, resolve));
}

const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { writeFile } = await import("node:fs/promises");

async function shot(name) {
  const r = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(`${prefix}-${name}.png`, Buffer.from(r.result.data, "base64"));
  console.log(`  存了 ${prefix}-${name}.png`);
}

await send("Page.enable");
await send("Runtime.enable");
await send("Log.enable");
const W = Number(process.env.LINLI_VW || 1180);
const H = Number(process.env.LINLI_VH || 800);
await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url });
await sleep(2600);

// 冻住会一直动的东西（否则两次抓图永远不同）
await evaluate(`
  (() => {
    const s = document.createElement("style");
    s.textContent = "#glassBg i{animation:none !important} *{animation-duration:0s !important; transition-duration:0s !important}";
    document.head.appendChild(s);
    return true;
  })()
`);

await shot("00-initial");

const steps = stepsArg ? JSON.parse(stepsArg) : [];
for (const step of steps) {
  let value;
  try {
    value = await evaluate(step.js);
  } catch (err) {
    value = "JS 抛错: " + err.message;
  }
  console.log(`  ${step.name}: ${JSON.stringify(value)}`);
  await sleep(step.wait ?? 700);
  if (step.shot !== false) await shot(step.name);
}

console.log(problems.length ? `\n!! 页面问题 ${problems.length} 条：\n` + problems.join("\n") : "\n页面没有报错");
ws.close();
