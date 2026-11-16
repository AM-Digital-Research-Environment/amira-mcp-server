// The page's one plain inline script (src/ui/page.ts appPage): it expands the
// gzip data element into the inline script that holds the bridge and the views,
// with the browser's own DecompressionStream. No network, eval or blob URL.
// A classic script, typechecked by tsconfig.views.json and minified at build.
(async () => {
  const data = document.getElementById("amira-app-bundle");
  try {
    if (typeof DecompressionStream !== "function") throw new Error("This host cannot decode gzip.");
    const bytes = Uint8Array.from(atob(data.textContent.trim()), (c) => c.charCodeAt(0));
    const source = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
    const script = document.createElement("script");
    script.textContent = source;
    document.body.appendChild(script);
    data.remove();
  } catch (error) {
    const root = document.getElementById("root");
    root.textContent = "The AMIRA app could not start in this host. The tool result in the conversation is unaffected.";
    root.setAttribute("role", "alert");
    console.error("[amira] app startup failed", error);
  }
})();
