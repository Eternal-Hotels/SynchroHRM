export function toCsv(rows, columns) {
    const lines = [];
    lines.push(columns.join(","));
    for (const row of rows) {
        const values = columns.map((column) => escapeCell(row[column]));
        lines.push(values.join(","));
    }
    return `${lines.join("\n")}\n`;
}
function escapeCell(value) {
    if (value === null || value === undefined) {
        return "";
    }
    const text = String(value);
    if (/[",\r\n]/.test(text)) {
        return `"${text.replace(/"/g, "\"\"")}"`;
    }
    return text;
}
