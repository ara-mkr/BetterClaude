const { EditorView, keymap, lineNumbers, highlightActiveLine } = require("@codemirror/view");
const { EditorState } = require("@codemirror/state");
const { defaultKeymap, history, historyKeymap } = require("@codemirror/commands");
const { css } = require("@codemirror/lang-css");
const { oneDark } = require("@codemirror/theme-one-dark");

function mount(container, { initialValue = "", onChange, language = "" } = {}) {
  const extensions = [
    lineNumbers(),
    highlightActiveLine(),
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    oneDark,
    EditorView.lineWrapping,
    EditorView.updateListener.of((update) => {
      if (update.docChanged && onChange) onChange(update.state.doc.toString());
    }),
    EditorView.theme({
      "&": { height: "100%", fontSize: "13px", backgroundColor: "transparent" },
      ".cm-scroller": { overflow: "auto", fontFamily: "SFMono-Regular, Menlo, Consolas, monospace" },
      ".cm-gutters": { backgroundColor: "transparent", borderRight: "1px solid var(--bc-ide-line, #2b3036)" },
      ".cm-activeLineGutter": { backgroundColor: "rgba(143, 224, 191, 0.08)" },
      ".cm-activeLine": { backgroundColor: "rgba(143, 224, 191, 0.035)" },
    }),
  ];

  // CSS is the only language package shipped today. Other files stay fully
  // editable as plain text until their language package is added deliberately.
  if (language === "css") extensions.push(css());

  const view = new EditorView({
    state: EditorState.create({ doc: initialValue, extensions }),
    parent: container,
  });

  return {
    getValue: () => view.state.doc.toString(),
    setValue: (value) => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: String(value) } }),
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}

module.exports = { mount };
