/**
 * AttachmentChip — the compact preview used for BOTH a pending (not-yet-sent)
 * attachment in the composer and a sent one in the Artifacts rail, so the two
 * surfaces show the same object rather than two different-looking guesses
 * about what got attached.
 *
 * Thumbnails only exist for images, and only for as long as the temp upload
 * dir keeps the bytes — GET /api/upload/{basename} 404s once it is swept, so
 * onError falls back to the generic icon rather than a broken-image glyph.
 * Non-image kinds never request a thumbnail at all; the backend 404s them
 * BY DESIGN (svg carries script; .py/.env/.html are readable by the model's
 * Read tool but must never be served over HTTP) and asking anyway would just
 * be a guaranteed failed request.
 *
 * CHAT.md 6a: the only hue permitted anywhere is the five artifact TYPE
 * tones, and only on a type icon + its label. A chip's icon is that type
 * icon, so code/chart/diff files borrow the SAME --cc-a-* variables already
 * used by the Artifacts rail (grep `--cc-a-image`) — no new colours. A file
 * that isn't one of the five known types (plain text, PDF, unknown) is not
 * a "type" in that sense and stays brightness-only (--cc-dim), not a sixth
 * invented hue.
 */
import { useState } from "react";
import { FileText, FileCode, FileSpreadsheet, File as FileIcon, X } from "lucide-react";

const MONO = "var(--cc-mono, ui-monospace, monospace)";

const CODE_EXT = new Set([
  "js", "jsx", "ts", "tsx", "py", "go", "rs", "java", "c", "cpp", "cs",
  "rb", "php", "json", "yaml", "yml", "sh", "css", "html", "sql",
]);
const CHART_EXT = new Set(["csv", "tsv", "xlsx", "xls"]);
const DIFF_EXT = new Set(["diff", "patch"]);

function extOf(filename) {
  const i = (filename || "").lastIndexOf(".");
  return i >= 0 ? filename.slice(i + 1).toLowerCase() : "";
}

/** Basename only — /api/upload/{name} takes a bare filename, never a path. */
function basename(path) {
  if (!path) return null;
  return path.split(/[\\/]/).pop();
}

function isImage(a) {
  return a.kind === "image" || (a.mime || "").startsWith("image/");
}

/** { Icon, tone } for a non-image attachment. tone is undefined for the
 *  brightness-only default — no invented sixth hue. */
function iconFor(filename) {
  const ext = extOf(filename);
  if (DIFF_EXT.has(ext)) return { Icon: FileText, tone: "var(--cc-a-diff)" };
  if (CHART_EXT.has(ext)) return { Icon: FileSpreadsheet, tone: "var(--cc-a-chart)" };
  if (CODE_EXT.has(ext)) return { Icon: FileCode, tone: "var(--cc-a-code)" };
  return { Icon: FileIcon, tone: "var(--cc-dim)" };
}

function fmtBytes(n) {
  if (!n && n !== 0) return null;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Middle-truncate, keeping the tail (extension + distinguishing suffix)
 *  visible — two files from the same exporter differ at the END of the
 *  name, so truncating the end is exactly wrong here. */
function middleTruncate(name, maxLen = 26) {
  if (!name || name.length <= maxLen) return name;
  const tailLen = Math.ceil(maxLen * 0.55);
  const headLen = maxLen - tailLen - 1;
  return `${name.slice(0, headLen)}…${name.slice(name.length - tailLen)}`;
}

export default function AttachmentChip({ attachment, onRemove }) {
  const a = attachment;
  const [thumbFailed, setThumbFailed] = useState(false);
  const name = a.filename || "attachment";
  const bytes = fmtBytes(a.size_bytes);
  const showThumb = isImage(a) && !thumbFailed && basename(a.path);
  const { Icon, tone } = iconFor(name);

  return (
    <span
      title={name}
      style={{
        display: "flex", alignItems: "center", gap: 6,
        height: 28, maxWidth: 220, boxSizing: "border-box",
        fontSize: 10.5, fontFamily: MONO, color: "var(--cc-dim)",
        border: "1px solid var(--cc-border)", borderRadius: 6,
        padding: "0 6px 0 4px", overflow: "hidden",
      }}
    >
      {showThumb ? (
        <img
          src={`/api/upload/${basename(a.path)}`}
          alt={name}
          onError={() => setThumbFailed(true)}
          style={{
            width: 18, height: 18, borderRadius: 3, objectFit: "cover",
            flexShrink: 0,
          }}
        />
      ) : (
        <Icon size={13} style={{ color: tone, flexShrink: 0 }} />
      )}
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                     color: "var(--cc-fg)" }}>
        {middleTruncate(name)}
      </span>
      {bytes && (
        <span style={{ color: "var(--cc-muted)", flexShrink: 0, whiteSpace: "nowrap" }}>
          {bytes}
        </span>
      )}
      {onRemove && (
        <button className="hover-color-red"
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${name}`}
          style={{ border: "none", background: "transparent", flexShrink: 0,
                   color: "var(--cc-muted)", cursor: "pointer",
                   padding: 0, lineHeight: 1, display: "flex" }}
        >
          <X size={11} />
        </button>
      )}
    </span>
  );
}
