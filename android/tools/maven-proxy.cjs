const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const port = Number(process.env.ETHERINGS_MAVEN_PROXY_PORT || 8765);
const root = path.resolve(__dirname, "..", ".gradle-proxy-cache");
const upstreamRoot = "https://repo.maven.apache.org/maven2/";
const inFlight = new Map();

function ensureInside(base, target) {
  const resolved = path.resolve(target);
  const normalizedBase = path.resolve(base) + path.sep;
  if (!resolved.startsWith(normalizedBase)) throw new Error("bad cache path");
  return resolved;
}

function cachePath(rel) {
  return ensureInside(root, path.join(root, "maven2", rel));
}

function quotePs(value) {
  return value.replace(/'/g, "''");
}

function downloadWithPowerShell(url, outFile) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const tmp = `${outFile}.${process.pid}.${Date.now()}.tmp`;
  const script = `
$ProgressPreference='SilentlyContinue'
try {
  Invoke-WebRequest -Uri '${quotePs(url)}' -UseBasicParsing -TimeoutSec 300 -OutFile '${quotePs(tmp)}'
  exit 0
} catch {
  $response = $_.Exception.Response
  if ($response -and [int]$response.StatusCode -eq 404) { exit 44 }
  Write-Error $_
  exit 1
}`;
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], { stdio: "pipe" });
    fs.renameSync(tmp, outFile);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    if (err.status === 44) {
      const missing = new Error(`HTTP 404 ${url}`);
      missing.statusCode = 404;
      throw missing;
    }
    throw err;
  }
}

async function ensureCached(rel, url, file) {
  if (fs.existsSync(file)) return;
  if (inFlight.has(file)) return inFlight.get(file);
  const promise = Promise.resolve().then(() => {
    if (!fs.existsSync(file)) {
      console.log(`MISS /maven2/${rel}`);
      downloadWithPowerShell(url, file);
    }
  }).finally(() => inFlight.delete(file));
  inFlight.set(file, promise);
  return promise;
}

const server = http.createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, `http://127.0.0.1:${port}`).pathname);
    if (!pathname.startsWith("/maven2/")) {
      res.writeHead(404);
      res.end("unknown route");
      return;
    }
    const rel = pathname.slice("/maven2/".length);
    if (!rel || rel.includes("..") || path.isAbsolute(rel)) {
      res.writeHead(400);
      res.end("bad path");
      return;
    }
    const file = cachePath(rel);
    await ensureCached(rel, upstreamRoot + rel, file);
    const stat = fs.statSync(file);
    res.writeHead(200, { "content-length": stat.size });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    fs.createReadStream(file).pipe(res);
  } catch (err) {
    const status = err && err.statusCode ? err.statusCode : 502;
    console.error(`ERR ${req.url}: ${err.message || err}`);
    res.writeHead(status);
    res.end(String(err.message || err));
  }
});

process.on("uncaughtException", (err) => console.error("uncaughtException", err));
process.on("unhandledRejection", (err) => console.error("unhandledRejection", err));

server.listen(port, "127.0.0.1", () => {
  console.log(`Etherings Maven Central proxy listening on http://127.0.0.1:${port}/maven2/`);
});