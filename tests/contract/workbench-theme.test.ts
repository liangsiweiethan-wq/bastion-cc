import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("workbench defaults to warm paper and toggles warm charcoal without inline scripts", async () => {
  const webHtml = await read("../../clients/web/index.html");
  const webCss = await read("../../clients/web/style.css");
  const webApp = await read("../../clients/web/app.js");
  const desktopHtml = await read("../../clients/desktop/src/index.html");
  const desktopRenderer = await read("../../clients/desktop/src/renderer.js");

  for (const html of [webHtml, desktopHtml]) {
    assert.match(html, /id="theme-toggle"/);
    assert.match(html, /切换深色主题/);
    assert.match(html, /#i-sun/);
    assert.match(html, /#i-moon/);
  }
  assert.match(desktopHtml, /Content-Security-Policy/);
  assert.match(desktopHtml, /object-src 'none'/);
  assert.equal(/<script(?![^>]*\bsrc=)/.test(desktopHtml), false);

  for (const source of [webCss, desktopHtml]) {
    assert.match(source, /#faf9f5/);
    assert.match(source, /#c05a38/);
    assert.match(source, /#1e1e1c/);
    assert.match(source, /\[data-theme="dark"\]/);
    assert.equal(source.includes("prefers-color-scheme"), false);
  }
  for (const source of [webApp, desktopRenderer]) {
    assert.match(source, /bastioncc\.theme/);
    assert.match(source, /dataset\.theme/);
    assert.match(source, /切换浅色主题/);
  }
});
