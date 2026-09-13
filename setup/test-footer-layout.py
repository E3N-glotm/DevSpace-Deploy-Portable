"""Render the real footer CSS in Edge; no screenshots or live Host interaction."""
import html
import json
import re
import subprocess
import tempfile
from pathlib import Path

root = Path(__file__).resolve().parents[1]
edge = Path("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe")
css = (root / "vendor/waishnav-devspace/dist/ui/assets/session-review.css").read_text(encoding="utf-8")
script = """
window.onload = () => {
  try {
    const root = document.querySelector('#app'), results = [];
    const height = () => root.getBoundingClientRect().height;
    for (const width of [180, 360, 800]) {
      root.style.width = width + 'px';
      root.innerHTML = '<details><summary>Task</summary><div style="height:160px">Details</div></details>';
      const footer = document.createElement('div');
      footer.className = 'devspace-version-footer';
      footer.textContent = 'DevSpace Portable 1.1.59 dev67 · Protocol 1.6';
      const absent = height();
      root.append(footer);
      const present = height();
      footer.remove();
      const removed = height();
      root.append(footer);
      footer.textContent = footer.textContent.repeat(8);
      const long = height();
      root.querySelector('details').open = true;
      const expanded = height();
      if (Math.max(absent,present,removed,long)-Math.min(absent,present,removed,long) > 0.1)
        throw new Error('Footer changed root height at width ' + width);
      if (expanded <= present) throw new Error('User expansion was clipped');
      results.push({width, absent, present, removed, long, expanded});
    }
    document.querySelector('#result').textContent = JSON.stringify({passed:true,results});
  } catch (error) { document.querySelector('#result').textContent = JSON.stringify({passed:false,error:String(error)}); }
};
"""
with tempfile.TemporaryDirectory(prefix="footer-layout-", dir=root / ".test-cache") as temporary:
    work = Path(temporary)
    page = work / "layout.html"
    page.write_text('<!doctype html><meta charset="utf-8"><style>' + css + '</style>'
                    '<div id="app"></div><pre id="result"></pre><script>' + script + '</script>', encoding="utf-8")
    result = subprocess.run([str(edge), "--headless", "--disable-gpu", "--no-first-run",
                             "--disable-extensions", "--no-default-browser-check",
                             "--user-data-dir=" + str(work / "profile"), "--virtual-time-budget=2000",
                             "--dump-dom", page.as_uri()], capture_output=True, timeout=45)
    text = result.stdout.decode("utf-8", errors="replace")
    match = re.search(r'<pre id="result">(.*?)</pre>', text, re.S)
    assert match, result.stderr.decode("utf-8", errors="replace")[-1500:]
    observation = json.loads(html.unescape(match.group(1)))
    assert observation["passed"], observation
    print(json.dumps(observation))
