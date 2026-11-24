// The install page written next to the build: a link to drag to the favourites bar, the same link to copy, and how to
// use the manager. One self-contained HTML file with no outside resources.

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

export function installPage({ bookmarklet, version, built, unpackedKb }) {
  const kb = (bookmarklet.length / 1024).toFixed(0);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Web Resources Manager</title>
<style>
  :root{color-scheme:light dark}
  body{font:15px/1.55 "Segoe UI",system-ui,sans-serif;color:#242424;background:#f5f5f5;margin:0}
  main{max-width:780px;margin:40px auto;padding:0 20px}
  h1{font-size:26px;margin:0 0 6px} h2{font-size:18px;margin-top:28px}
  .lede{color:#424242;margin-top:0}
  .card{background:#fff;border-radius:8px;padding:20px 22px;box-shadow:0 0 2px rgba(0,0,0,.12),0 2px 4px rgba(0,0,0,.14)}
  a.bm{display:inline-flex;align-items:center;gap:8px;background:#007acc;color:#fff;text-decoration:none;padding:8px 16px;border-radius:4px;font-weight:600;cursor:grab}
  a.bm:active{cursor:grabbing}
  ol li,ul li{margin:6px 0} code{background:#f0f0f0;padding:1px 5px;border-radius:4px;font-size:13px}
  textarea{width:100%;height:90px;font:12px Consolas,monospace;border:1px solid #d1d1d1;border-radius:4px;padding:8px;box-sizing:border-box;background:#fff;color:#242424}
  button{font:inherit;border:1px solid #d1d1d1;background:#fff;color:#242424;border-radius:4px;padding:5px 12px;cursor:pointer}
  .note{border-left:4px solid #007acc;background:#eef6fc;padding:10px 14px;border-radius:4px}
  .warn{border-left:4px solid #c50f1f;background:#fdf3f4;padding:10px 14px;border-radius:4px}
  .muted{color:#616161;font-size:13px}
  @media (prefers-color-scheme:dark){
    body{background:#1e1e1e;color:#d4d4d4}.lede{color:#bbb}.card{background:#252526;box-shadow:none;border:1px solid #3c3c3c}
    code{background:#333}textarea,button{background:#3c3c3c;color:#ccc;border-color:#555}.note{background:#0b2a40}.warn{background:#3a1d1d}.muted{color:#999}
  }
</style></head><body><main>
<h1>Web Resources Manager</h1>
<p class="lede">A Visual Studio Code-style editor for the web resources of a Dynamics 365 / Power Apps environment: browse them by folder or solution, edit with syntax colouring, IntelliSense for the Xrm client API and formatting, compare every change, then save and publish with a check that nobody changed them meanwhile. It runs in Edge with your own sign-in; nothing is installed in the environment.</p>
<div class="card">
<h2 style="margin-top:0">Install</h2>
<ol>
  <li>Show the favourites bar (Ctrl+Shift+B).</li>
  <li>Drag this button onto the favourites bar: <a class="bm" href="${esc(bookmarklet)}">&lt;/&gt; Web resources</a></li>
</ol>
<p>If dragging does not work: create a new favourite named <b>Web resources</b> and paste this as its URL.</p>
<textarea id="code" readonly placeholder="The link is the button's address (also in dist/wrm.bookmarklet.txt)."></textarea>
<p><button id="copy">Copy</button> <span id="copied"></span></p>
</div>
<h2>Use</h2>
<ol>
  <li>Open a page of the environment (for example <code>https://contoso.crm.dynamics.com</code>), or an environment's Solutions page in the maker portal (make.powerapps.com).</li>
  <li>Click <b>Web resources</b> in the favourites bar. The manager opens over the page; click the bookmark again (or <b>–</b>) to hide it, and once more to bring it back as you left it.</li>
  <li>Pick a solution (or all web resources), open files from the Explorer, edit, and use <b>Source Control</b> (Ctrl+Shift+G) to see every change before you save (Ctrl+S) and publish.</li>
</ol>
<p class="note">Before each save the manager reads the web resource again: if someone saved or published a change since you opened it, nothing is overwritten. You get a side-by-side comparison of their version and yours, and choose. Unsaved edits are kept in this browser as drafts, so a reload or a crash loses nothing.</p>
<p class="warn">Publishing makes a web resource live for every user of the environment. In environments marked <b>Production</b> the status bar turns red and publishing asks for confirmation.</p>
<p class="muted">Version ${esc(version)} · built ${esc(built)} · ${kb} KB link (${unpackedKb} KB unpacked) · Microsoft Edge 120 or later (Chrome works too).</p>
</main>
<script>
// The box shows the button's own address: the link is in the page once, not twice (it is almost 2 million characters).
const code = document.getElementById('code');
code.value = document.querySelector('a.bm').getAttribute('href');
document.getElementById('copy').onclick = async () => {
  await navigator.clipboard.writeText(code.value);
  document.getElementById('copied').textContent = 'Copied.';
};
</script>
</body></html>`;
}
