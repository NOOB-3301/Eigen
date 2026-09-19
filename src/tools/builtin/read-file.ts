import { readdir, readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { defineTool } from "../registry.ts";
import { expandHome } from "../../config/home.ts";

export const readFileTool = defineTool({
  name: "read_file",
  description: "Read a UTF-8 text file. If the path is a directory, list its entries instead.",
  inputSchema: z.object({ path: z.string().min(1).describe("File or directory path; ~ is expanded") }),
  async execute({ path }, { signal }) {
    const p = expandHome(path);
    const st = await stat(p);
    if (st.isDirectory()) {
      const entries = await readdir(p, { withFileTypes: true });
      return entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort().join("\n") || "(empty directory)";
    }
    const buf = await readFile(p, { signal });
    if (buf.subarray(0, 8000).includes(0)) return { content: [{ type: "text", text: `${p} looks binary (${st.size} bytes); not shown.` }], isError: true };
    return buf.toString("utf8");
  },
});
