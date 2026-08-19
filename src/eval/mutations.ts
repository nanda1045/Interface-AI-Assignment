/** A UI change injected into the page before a capability replays, used to
 *  measure what the locator ladder actually survives.
 *
 *  These run in the browser rather than in the target application, for two
 *  reasons. The harness then works against any surface instead of only the
 *  fictional app it was written beside, and the application under test stays
 *  exactly the application the capability was recorded against - the mutation
 *  is the only variable.
 *
 *  The governing constraint: a mutation may change how an element is *found*
 *  and must not change what the application *does*. Renaming a form control's
 *  `name` attribute, for instance, breaks the POST the server expects, so every
 *  capability would fail and the result would describe a broken app rather than
 *  a fragile locator. `id` is a scripting hook and is fair game; `name` is part
 *  of the form contract and is left alone.
 */
export interface UiMutation {
  id: string;
  describes: string;
  /** Expected to break these strategy kinds, written down before measuring. */
  predicts: string[];
  script: string;
}

// Init scripts run before the application's own, so the work is deferred until
// the document exists. Full page loads mean this fires once per navigation.
function onReady(body: string): string {
  return `document.addEventListener("DOMContentLoaded", function () { try { ${body} } catch (error) { console.error("mutation failed", error); } });`;
}

// Composed below as well as used on their own: a mutation only exercises the
// rungs the ladder actually falls through to, so breaking a positional strategy
// requires first taking away the semantic ones that would otherwise satisfy the
// resolve before it ever gets there.
const relabelBody = `
      var index = 0;
      var relabel = function (node) {
        if (node.children.length === 0 && node.textContent && node.textContent.trim()) {
          node.textContent = "Field " + (index += 1);
        }
      };
      document.querySelectorAll("th,label,button,a,legend").forEach(relabel);
      document.querySelectorAll("td").forEach(function (cell) {
        if (cell.nextElementSibling) { relabel(cell); }
      });
      document.querySelectorAll("input[type=submit],input[type=button]").forEach(function (node) {
        if (node.value) { node.value = "Field " + (index += 1); }
      });
    `;

const insertRowBody = `
      document.querySelectorAll("table").forEach(function (table) {
        var body = table.tBodies[0] || table;
        var first = body.rows ? body.rows[0] : null;
        if (!first) { return; }
        var row = document.createElement("tr");
        for (var cell = 0; cell < first.cells.length; cell += 1) {
          var td = document.createElement("td");
          td.textContent = "\\u00a0";
          row.appendChild(td);
        }
        body.insertBefore(row, first);
      });
    `;

export const uiMutations: UiMutation[] = [
  {
    id: "none",
    describes: "Unmodified page, to show the capability passes before anything is changed",
    predicts: [],
    script: ""
  },
  {
    id: "rewrite_classes",
    describes: "Every class attribute replaced — a pure restyling",
    predicts: [],
    script: onReady(`
      var index = 0;
      document.querySelectorAll("[class]").forEach(function (node) { node.setAttribute("class", "r" + (index += 1)); });
    `)
  },
  {
    id: "extend_labels",
    describes: "Wording extended, as a clarifying edit would do — the original text is still a substring",
    predicts: ["role_name", "label_proximity"],
    // The trailing cell of a row is deliberately left alone. That is where a
    // value sits, and rewriting it would confound the question being asked -
    // "can the ladder still find the right element" - with "is the value what
    // we expected". A label cell is one with another cell after it, which is a
    // structural rule rather than anything specific to this application.
    script: onReady(`
      var rename = function (node) {
        if (node.children.length === 0 && node.textContent && node.textContent.trim()) {
          node.textContent = node.textContent.trim() + " (updated)";
        }
      };
      document.querySelectorAll("th,label,button,a,legend").forEach(rename);
      document.querySelectorAll("td").forEach(function (cell) {
        if (cell.nextElementSibling) { rename(cell); }
      });
      document.querySelectorAll("input[type=submit],input[type=button]").forEach(function (node) {
        if (node.value) { node.value = node.value + " (updated)"; }
      });
    `)
  },
  {
    id: "rename_labels",
    describes: "Wording replaced outright, as a terminology change would do — nothing of the original survives",
    // Separate from extend_labels on purpose. Appending leaves the old wording
    // as a substring, which exact-match strategies lose and substring-match
    // strategies quietly survive; only a full replacement tests both.
    predicts: ["role_name", "label_proximity", "text", "label_adjacent_cell"],
    script: onReady(relabelBody)
  },
  {
    id: "mangle_ids",
    describes: "Every id rewritten, as a framework upgrade would do. Form names are left alone so the app still works",
    predicts: ["attr_css"],
    script: onReady(`
      var index = 0;
      document.querySelectorAll("[id]").forEach(function (node) { node.setAttribute("id", "g" + (index += 1)); });
    `)
  },
  {
    id: "insert_table_row",
    describes: "A row added at the top of every table, shifting positional paths",
    predicts: ["structural", "geometry"],
    script: onReady(insertRowBody)
  },
  {
    id: "rename_and_reflow",
    describes: "Terminology change plus a layout reflow — strips the semantic rungs, then moves the positional ones they were hiding",
    predicts: ["role_name", "label_proximity", "text", "label_adjacent_cell", "structural", "geometry"],
    script: onReady(relabelBody) + onReady(insertRowBody)
  },
  {
    id: "wrap_layout",
    describes: "Every table wrapped in an extra container, as a layout refactor would do",
    predicts: ["structural"],
    script: onReady(`
      document.querySelectorAll("table").forEach(function (table) {
        var wrapper = document.createElement("div");
        table.parentNode.insertBefore(wrapper, table);
        wrapper.appendChild(table);
      });
    `)
  }
];

export function mutationById(id: string): UiMutation {
  const found = uiMutations.find((mutation) => mutation.id === id);
  if (!found) throw new Error(`Unknown mutation ${id}. Available: ${uiMutations.map((mutation) => mutation.id).join(", ")}`);
  return found;
}
