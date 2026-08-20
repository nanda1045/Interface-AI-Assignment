// Browser-injected UI drift scenarios. They change how elements are found while
// preserving application behaviour, keeping locator resilience as the variable
// under test; form `name` values are therefore left unchanged.
export interface UiMutation {
  id: string;
  describes: string;
  // Strategy kinds predicted to fail before the scenario is measured.
  predicts: string[];
  script: string;
}

// Init scripts register before application code, then mutate each loaded DOM only
// after it exists.
function onReady(body: string): string {
  return `document.addEventListener("DOMContentLoaded", function () { try { ${body} } catch (error) { console.error("mutation failed", error); } });`;
}

// Shared building blocks allow compound scenarios to remove semantic rungs first
// and then exercise the positional fallbacks they normally hide.
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
    // Rewrite labels, not trailing value cells, so outputs stay semantically valid.
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
    // Full replacement breaks both exact and substring matches.
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
