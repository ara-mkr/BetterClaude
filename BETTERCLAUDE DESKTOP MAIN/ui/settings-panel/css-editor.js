/**
 * CodeMirror 6 CSS editor, bundled to an IIFE (window.BetterClaudeCSSEditor)
 * by esbuild.config.js since @codemirror/* packages ship ESM-only and
 * preload.js loads modules via CommonJS require().
 */
const { EditorView, keymap, lineNumbers, highlightActiveLine } = require("@codemirror/view");
const { EditorState } = require("@codemirror/state");
const { defaultKeymap, history, historyKeymap } = require("@codemirror/commands");
const { css } = require("@codemirror/lang-css");
const { oneDark } = require("@codemirror/theme-one-dark");

function mount(container, { initialValue = "", onChange } = {}) {
  const view = new EditorView({
    state: EditorState.create({
      doc: initialValue,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        css(),
        oneDark,
        EditorView.updateListener.of((update) => {
          if (update.docChanged && onChange) onChange(update.state.doc.toString());
        }),
        EditorView.theme({
          "&": { height: "100%", fontSize: "13px" },
          ".cm-scroller": { overflow: "auto", fontFamily: "SFMono-Regular, Menlo, Consolas, monospace" },
        }),
      ],
    }),
    parent: container,
  });

  return {
    setValue(value) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    },
    getValue() {
      return view.state.doc.toString();
    },
    destroy() {
      view.destroy();
    },
  };
}

module.exports = { mount };
