// Allow wrangler/esbuild `?raw` imports: returns the file contents as a string.
declare module "*?raw" {
  const content: string;
  export default content;
}

// Client module is plain JS wrapped in a default function; declare its shape
// so TypeScript can resolve the import in src/index.ts.
