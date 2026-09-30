import { useEffect, useRef } from "react";
import Editor, { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import JsonWorker from "monaco-editor/language/json/json.worker.js?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker.js?worker";
import { Save, X, RotateCcw, Columns2, Maximize2 } from "lucide-react";
import { FileIcon, IconButton } from "./Components";
import type { Doc, Settings } from "./types";
// Local workers and assets: the editor works offline and never loads a CDN.
(self as any).MonacoEnvironment = {
  getWorker(_: string, label: string) {
    return label === "json"
      ? new JsonWorker()
      : label === "typescript" || label === "javascript"
        ? new TsWorker()
        : new EditorWorker();
  },
};
loader.config({ monaco });
export default function EditorPane({
  docs,
  active,
  onActive,
  onChange,
  onSave,
  onClose,
  onReload,
  settings,
  expanded,
  onExpand,
}: {
  docs: Doc[];
  active: Doc;
  onActive: (doc: Doc) => void;
  onChange: (value: string) => void;
  onSave: () => void;
  onClose: (doc: Doc) => void;
  onReload: () => void;
  settings: Settings;
  expanded: boolean;
  onExpand: () => void;
}) {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const saveRef = useRef(onSave);
  saveRef.current = onSave;
  useEffect(() => {
    monaco.editor.defineTheme("lumen", {
      base: settings.theme === "Paper" ? "vs" : "vs-dark",
      inherit: true,
      rules: [],
      colors: {
        "editor.background": settings.bg,
        "editor.foreground": settings.text,
        "editorLineNumber.foreground": settings.muted,
        "editor.lineHighlightBackground": settings.surface,
        "editor.selectionBackground": `${settings.accent}33`,
        "editorCursor.foreground": settings.accent,
        "editorWidget.background": settings.surface,
      },
    });
    monaco.editor.setTheme("lumen");
  }, [settings]);
  const extension = active.path.split(".").at(-1);
  const language =
    (
      {
        ts: "typescript",
        tsx: "typescript",
        js: "javascript",
        jsx: "javascript",
        mjs: "javascript",
        json: "json",
        md: "markdown",
        css: "css",
        html: "html",
        py: "python",
        rs: "rust",
        go: "go",
        yaml: "yaml",
        yml: "yaml",
        toml: "ini",
        ps1: "powershell",
        sh: "shell",
        sql: "sql",
      } as Record<string, string>
    )[extension || ""] || "plaintext";
  return (
    <section className="editor-pane" aria-label="File editor">
      <div className="editor-tabs">
        {docs.map((doc) => (
          <div
            key={doc.root + doc.path}
            className={`editor-tab ${doc === active ? "selected" : ""}`}
          >
            <button onClick={() => onActive(doc)} title={doc.path}>
              <FileIcon name={doc.path} />
              <span>{doc.path.split("/").at(-1)}</span>
              {doc.content !== doc.saved && <i className="dirty-dot" />}
            </button>
            <IconButton
              label={`Close ${doc.path}`}
              onClick={() => onClose(doc)}
            >
              <X size={12} />
            </IconButton>
          </div>
        ))}
      </div>
      <div className="editor-toolbar">
        <span title={active.path}>{active.path}</span>
        <div>
          <IconButton label="Reload file from disk" onClick={onReload}>
            <RotateCcw size={14} />
          </IconButton>
          <IconButton
            label={expanded ? "Show conversation" : "Expand editor"}
            onClick={onExpand}
          >
            {expanded ? <Columns2 size={14} /> : <Maximize2 size={14} />}
          </IconButton>
          <button
            className="save-button"
            disabled={active.content === active.saved}
            onClick={onSave}
          >
            <Save size={13} />
            Save <kbd>Ctrl S</kbd>
          </button>
        </div>
      </div>
      <div className="monaco-host">
        <Editor
          key={active.root + active.path}
          path={`${active.root}/${active.path}`}
          value={active.content}
          language={language}
          theme="lumen"
          onChange={(value) => onChange(value || "")}
          onMount={(editor) => {
            editorRef.current = editor;
            editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () =>
              saveRef.current(),
            );
          }}
          options={{
            fontSize: 14,
            fontFamily: '"Cascadia Code", Consolas, monospace',
            minimap: { enabled: false },
            padding: { top: 20 },
            scrollBeyondLastLine: false,
            wordWrap: "on",
            automaticLayout: true,
            smoothScrolling: settings.motion,
            tabSize: 2,
            renderLineHighlight: "gutter",
            overviewRulerBorder: false,
            bracketPairColorization: { enabled: true },
          }}
          loading={<div className="editor-loading">Opening editor…</div>}
        />
      </div>
      <footer className="editor-footer">
        <span>{language}</span>
        <span>
          {active.content === active.saved ? "Saved" : "Unsaved changes"}
        </span>
        <span>UTF-8</span>
      </footer>
    </section>
  );
}
