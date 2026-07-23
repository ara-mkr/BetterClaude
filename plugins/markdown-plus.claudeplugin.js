/**
 * Markdown+ — adds copy-to-clipboard buttons on code blocks and tidies up
 * code block styling. Demonstrates api.injectCSS + api.onMessage.
 */
module.exports = {
  name: "Markdown+",
  version: "1.0.0",

  onLoad(api) {
    api.injectCSS(`
      pre { position: relative; }
      .bc-md-copy-btn {
        position: absolute;
        top: 6px;
        right: 6px;
        font-size: 11px;
        padding: 3px 8px;
        border-radius: 5px;
        border: 1px solid rgba(255,255,255,0.15);
        background: rgba(0,0,0,0.35);
        color: #fff;
        cursor: pointer;
        opacity: 0;
        transition: opacity 120ms ease;
      }
      pre:hover .bc-md-copy-btn { opacity: 1; }
    `);

    const decorate = () => {
      api.queryAll("pre").forEach((pre) => {
        if (pre.querySelector(".bc-md-copy-btn")) return;
        const btn = document.createElement("button");
        btn.className = "bc-md-copy-btn";
        btn.textContent = "Copy";
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const code = pre.querySelector("code");
          const text = code ? code.innerText : pre.innerText;
          navigator.clipboard.writeText(text).then(() => {
            btn.textContent = "Copied!";
            setTimeout(() => (btn.textContent = "Copy"), 1200);
          });
        });
        pre.appendChild(btn);
      });
    };

    this._observer = new MutationObserver(decorate);
    this._observer.observe(document.body, { childList: true, subtree: true });
    decorate();

    this._unsubscribe = api.onMessage(() => decorate());
  },

  onUnload() {
    if (this._observer) this._observer.disconnect();
    if (this._unsubscribe) this._unsubscribe();
  },
};
