// 真渲染体检：无头 Edge + CDP 抓图。
//
// 用法：node tools/shot.mjs <页面地址> <输出前缀>
//
// ★ 为什么自己写而不用现成的：机器上没装 playwright / puppeteer。
//   Node 22 自带全局 WebSocket（undici），CDP 那几条消息用不着装东西。
// ★ 抓图前先冻住氛围层（#glassBg i 的 animation）和入场动画：
//   不冻的话同一页抓两次都不一样，"这处变没变"就无从判断。
const [url, prefix] = process.argv.slice(2);
if (!url || !prefix) {
  console.error("用法：node tools/shot.mjs <url> <out-prefix>");
  process.exit(2);
}

const res = await fetch("http://127.0.0.1:9333/json/list");
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
    problems.push(msg.params?.exceptionDetails?.exception?.description ?? "未知异常");
  }
  if (msg.method === "Runtime.consoleAPICalled" && msg.params?.type === "error") {
    problems.push(msg.params.args?.map((a) => a.value ?? a.description).join(" "));
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

async function shot(name) {
  const r = await send("Page.captureScreenshot", { format: "png" });
  const { writeFile } = await import("node:fs/promises");
  await writeFile(`${prefix}-${name}.png`, Buffer.from(r.result.data, "base64"));
  console.log(`  存了 ${prefix}-${name}.png`);
}

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1180, height: 800, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url });
await sleep(2200);

// 冻住会一直动的东西（否则两次抓图永远不同）
await evaluate(`
  (() => {
    const s = document.createElement("style");
    s.textContent = "#glassBg i{animation:none !important} *{animation-duration:0s !important; transition-duration:0s !important}";
    document.head.appendChild(s);
    return true;
  })()
`);

await shot("mail");

// argv: [node, 脚本, url, 输出前缀, 步骤 JSON]
const steps = process.argv[4] ? JSON.parse(process.argv[4]) : [];
for (const step of steps) {
  const value = await evaluate(step.js);
  console.log(`  ${step.name}: ${JSON.stringify(value)}`);
  await sleep(step.wait ?? 700);
  if (step.shot !== false) await shot(step.name);
}

console.log(problems.length ? `\n!! 页面报错 ${problems.length} 条：\n` + problems.join("\n") : "\n页面没有报错");
ws.close();
