// Build each tool's zod schemas once per process.
//
// The HTTP transport creates a server per request (stateless, SEP-2567), and
// every registerTool call used to construct its input and output schemas
// afresh: about half of the 2–3 ms a server took to build. A tool's schemas
// are fixed for the life of the process, and zod schemas are immutable, so the
// first build is shared by every later server.
const SCHEMAS = new Map<string, unknown>();

export function schemaOnce<T>(key: string, build: () => T): T {
  let schema = SCHEMAS.get(key) as T | undefined;
  if (schema === undefined) {
    schema = build();
    SCHEMAS.set(key, schema);
  }
  return schema;
}
