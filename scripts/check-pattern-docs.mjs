// Every pattern document must contain the nine catalogue sections, in order, and at least one Mermaid diagram.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REQUIRED = [
  "Problem",
  "Context",
  "Solution",
  "Architecture",
  "Example",
  "Advantages",
  "Trade-offs",
  "When to use",
  "When NOT to use",
];
const dir = new URL("../docs/patterns/", import.meta.url).pathname;
let problems = 0;
const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
for (const file of files) {
  const text = readFileSync(join(dir, file), "utf8");
  const headings = [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());
  const missing = REQUIRED.filter((h) => !headings.includes(h));
  const order = headings.filter((h) => REQUIRED.includes(h));
  if (missing.length) {
    console.log(`${file}: missing ${missing.join(", ")}`);
    problems++;
  } else if (order.join("|") !== REQUIRED.join("|")) {
    console.log(`${file}: sections out of order`);
    problems++;
  }
  if (!text.includes("```mermaid")) {
    console.log(`${file}: no Mermaid diagram`);
    problems++;
  }
}
console.log(`checked ${files.length} pattern documents, ${problems} problems`);
process.exit(problems ? 1 : 0);
