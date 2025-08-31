const defaultOverrides = {
  // Example: owner_company: 'Company'
};

function toTitleCaseFromSnake(name) {
  return name
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(' ');
}

function formatTableHeaders(columnNames, overrides = defaultOverrides) {
  return columnNames.map((key) => {
    const displayName = overrides[key] || toTitleCaseFromSnake(key);
    return { key, displayName };
  });
}

module.exports = { formatTableHeaders };


