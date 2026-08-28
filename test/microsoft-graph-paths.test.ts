import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";

const SCRIPT = join(process.cwd(), "skills-seed", "microsoft-graph", "scripts", "graph.py");

const DRIVER = `
import importlib.util, json, os, sys, tempfile, types
os.environ["VAULT_TOKEN_GRAPH_MICROSOFT_COM"] = "t"
spec = importlib.util.spec_from_file_location("graph", sys.argv[1])
graph = importlib.util.module_from_spec(spec)
spec.loader.exec_module(graph)

seen = []
graph.paginate = lambda path, query=None, headers=None, limit=None: (seen.append(path) or [])
graph.call = lambda method, path, *a, **k: (seen.append(path) or {})

graph.run_files(types.SimpleNamespace(cmd="browse", drive="D", item=None, path="Reports/2026 Q1"))
graph.run_files(types.SimpleNamespace(cmd="browse", drive=None, item=None, path="Shared Documents/Q1"))
tmp = tempfile.NamedTemporaryFile(delete=False)
tmp.write(b"x")
tmp.close()
graph.run_files(
    types.SimpleNamespace(cmd="upload", drive="D", item=None, parent="P", name="Q3 Report.docx", in_path=tmp.name)
)
print(json.dumps(seen))
`;

const havePython = spawnSync("python3", ["--version"]).status === 0;

test(
  "browse-by-path and new-content upload percent-encode name/path segments so spaces don't crash urllib",
  { skip: !havePython },
  () => {
    const out = execFileSync("python3", ["-c", DRIVER, SCRIPT], { encoding: "utf8" });
    const lastLine = out.trim().split("\n").at(-1)!;
    const paths = JSON.parse(lastLine) as string[];
    assert.deepEqual(paths, [
      "drives/D/root:/Reports/2026%20Q1:/children",
      "me/drive/root:/Shared%20Documents/Q1:/children",
      "drives/D/items/P:/Q3%20Report.docx:/content",
    ]);
    for (const p of paths) assert.doesNotMatch(p, / /, "a raw space would raise http.client.InvalidURL");
  },
);
