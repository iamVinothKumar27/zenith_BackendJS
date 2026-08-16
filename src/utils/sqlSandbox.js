import Database from "better-sqlite3";

export function sqlRowsToText(rows, columns = null) {
  const cols = (columns || []).map(String);
  const safeRows = (rows || []).map((row) => {
    if (Array.isArray(row)) return row.map((v) => (v == null ? "" : String(v)));
    return [row == null ? "" : String(row)];
  });
  const lines = [];
  if (cols.length) lines.push(cols.join(" | "));
  if (safeRows.length) {
    for (const row of safeRows) lines.push(row.join(" | "));
  } else {
    lines.push("(no rows)");
  }
  return lines.join("\n");
}

export function normalizeSqlResultRows(rows) {
  const out = [];
  for (let row of rows || []) {
    if (row && typeof row === "object" && !Array.isArray(row)) row = Object.values(row);
    if (!Array.isArray(row)) row = [row];
    const vals = row.map((v) => {
      if (v == null) return null;
      if (typeof v === "number" && !Number.isInteger(v)) return Math.round(v * 1e6) / 1e6;
      return v;
    });
    out.push(vals);
  }
  return out;
}

/** Run setup_sql then query_sql against a throwaway in-memory SQLite DB; returns {columns, rows}. */
export function executeSqlQuery(setupSql, querySql) {
  const db = new Database(":memory:");
  try {
    db.exec(setupSql || "");
    const stmt = db.prepare(querySql || "");
    const rawRows = stmt.all();
    const columns = stmt.columns().map((c) => c.name);
    const rows = normalizeSqlResultRows(rawRows.map((r) => columns.map((c) => r[c])));
    return { columns, rows };
  } finally {
    db.close();
  }
}

const SQLITE_TYPE_MAP = {
  INT: "Int64",
  INTEGER: "Int64",
  REAL: "float",
  FLOAT: "float",
  DOUBLE: "float",
  NUMERIC: "float",
  DECIMAL: "float",
  TEXT: "string",
  CHAR: "string",
  VARCHAR: "string",
  DATE: "string",
  DATETIME: "string",
};

/** Build a pandas-equivalent Python schema snippet from a SQLite schema + sample data (mirrors Python's _build_sql_pandas_schema). */
export function buildSqlPandasSchema(schemaSql, sampleDataSql) {
  const db = new Database(":memory:");
  try {
    db.exec((schemaSql || "") + "\n" + (sampleDataSql || ""));
    const tableRows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all();
    const tables = tableRows.map((r) => String(r.name));
    if (!tables.length) return "import pandas as pd\n";

    const lines = ["import pandas as pd", ""];
    tables.forEach((table, idx) => {
      const pragmaRows = db.prepare(`PRAGMA table_info("${table}")`).all();
      const colNames = pragmaRows.map((r) => String(r.name));
      const colTypes = pragmaRows.map((r) => String(r.type || "").toUpperCase());
      const rows = db.prepare(`SELECT * FROM "${table}"`).all();
      const dataRows = rows.map((r) => colNames.map((c) => r[c]));
      const varName = table.toLowerCase().replace(/[^a-z0-9]/g, "_") || "df";

      lines.push(`data = ${JSON.stringify(dataRows)}`);
      lines.push(`${varName} = pd.DataFrame(data, columns=${JSON.stringify(colNames)})`);

      const astypeMap = {};
      colNames.forEach((name, i) => {
        const ctype = colTypes[i];
        for (const [key, mapped] of Object.entries(SQLITE_TYPE_MAP)) {
          if (ctype.includes(key)) {
            astypeMap[name] = mapped;
            break;
          }
        }
      });
      if (Object.keys(astypeMap).length) {
        lines.push(`${varName} = ${varName}.astype(${JSON.stringify(astypeMap)})`);
      }
      if (idx !== tables.length - 1) lines.push("");
    });
    return lines.join("\n").trim() + "\n";
  } finally {
    db.close();
  }
}

export function compareSqlResults(actual, expected) {
  const aCols = (actual.columns || []).map(String);
  const eCols = (expected.columns || []).map(String);
  const aRows = actual.rows || [];
  const eRows = expected.rows || [];
  return JSON.stringify(aCols) === JSON.stringify(eCols) && JSON.stringify(aRows) === JSON.stringify(eRows);
}

export function sqlStarterQuery() {
  return "-- Write your SQL query below\n-- Tables and data are preloaded for every test dataset.\n\nSELECT 1;\n";
}
